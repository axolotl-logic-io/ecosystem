// The issue branch against its base: prepare-review writes the diff a review
// reads, sync-base rebases the branch onto the moved base, and finish-sync
// checks and pushes a rebase a writer resolved. None of them calls gh.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { recordPush } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { assertClean, fetchIn, head, remoteHead } from "../git-state.ts";
import { git } from "../github.ts";
import { parseRequest, run } from "../process.ts";
import {
  abortRebase,
  rebaseInProgress,
  rebaseProblem,
  unmergedFiles,
} from "../rebase.ts";
import { wikiDiff } from "../wiki.ts";

interface ReviewReply {
  headSha: string;
  baseSha: string;
  diffPath: string;
  diffLines: number;
  changedFiles: string[];
}

type SyncReply =
  | { changed: false; conflict: false; headSha: string }
  | { changed: true; conflict: false; headSha: string }
  | SyncConflict;

interface SyncConflict {
  changed: false;
  conflict: true;
  inRebase: boolean;
  conflicts: string[];
  baseSha: string;
}

type FinishReply =
  | { resolved: false; reason: string }
  | { resolved: true; headSha: string };

type Op = (
  cfg: Config,
  request: unknown,
) => ReviewReply | SyncReply | FinishReply;

const REVIEW_REQUEST = z.looseObject({
  number: z.number().int(),
  sinceSha: z.string().nullish(),
  tag: z.string().nullish(),
});
const SYNC_REQUEST = z.looseObject({
  number: z.number().int(),
  keepConflict: z.boolean().nullish(),
});
const FINISH_REQUEST = z.looseObject({
  number: z.number().int(),
  abort: z.boolean().nullish(),
  reason: z.string().nullish(),
});

function present(text: string | null | undefined): text is string {
  return text !== undefined && text !== null && text !== "";
}

// `text`, or `fallback` when it is missing or empty.
function textOr(text: string | null | undefined, fallback: string): string {
  if (present(text)) {
    return text;
  }
  return fallback;
}

function gitOut(wt: string, args: readonly string[]): string {
  return run("git", ["-C", wt, ...args]).stdout;
}

function gitSucceeds(wt: string, args: readonly string[]): boolean {
  return run("git", ["-C", wt, ...args], { allowFail: true }).code === 0;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line !== "");
}

// A sync rebases the branch, so an earlier reviewed commit may no longer be in its
// history. Diffing from it would then show everything the base gained since, so
// review the whole branch instead.
function reviewFrom(
  wt: string,
  sinceSha: string | null | undefined,
  { headSha, baseSha }: { headSha: string; baseSha: string },
): string {
  if (!present(sinceSha)) {
    return baseSha;
  }
  if (gitSucceeds(wt, ["merge-base", "--is-ancestor", sinceSha, headSha])) {
    return sinceSha;
  }
  return baseSha;
}

// Wiki commits come after the code diff. They are always the whole wiki change so
// far, even in a re-review that shows only the code since the last review.
function withWiki(
  cfg: Config,
  n: number,
  diff: string,
): { text: string; files: string[] } {
  const wiki = wikiDiff(cfg, n);
  const settings = wikiCfg(cfg);
  if (wiki.diff === "" || settings === null) {
    return { text: diff, files: wiki.files };
  }
  const heading = `# Wiki changes (paths under ${settings.dir}/; pushed to the wiki when the PR merges)`;
  return { text: `${diff}\n\n${heading}\n\n${wiki.diff}`, files: wiki.files };
}

function prepareReview(cfg: Config, request: unknown): ReviewReply {
  const req = parseRequest(REVIEW_REQUEST, "prepare-review", request);
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  const headSha = head(wt);
  const baseArgs = ["merge-base", `origin/${cfg.baseBranch}`, "HEAD"];
  const baseSha = gitOut(wt, baseArgs).trim();
  const from = reviewFrom(wt, req.sinceSha, { headSha, baseSha });
  const diff = gitOut(wt, ["diff", "--stat", "--patch", `${from}..${headSha}`]);
  const names = gitOut(wt, ["diff", "--name-only", `${baseSha}..${headSha}`]);
  const tag = `review-${textOr(req.tag, "r0")}`;
  const dir = path.join(paths.runDir(cfg, n), tag);
  fs.mkdirSync(dir, { recursive: true });
  const diffPath = path.join(dir, "diff.patch");
  const full = withWiki(cfg, n, diff);
  fs.writeFileSync(diffPath, full.text);
  return {
    headSha,
    baseSha,
    diffPath,
    diffLines: full.text.split("\n").length,
    changedFiles: nonEmptyLines(names).concat(full.files),
  };
}

// Puts the worktree back on the pushed branch, dropping a half-done rebase.
function resetToRemote(cfg: Config, n: number): void {
  const wt = paths.worktree(cfg, n);
  abortRebase(wt);
  const remote = remoteHead(cfg, n);
  if (remote !== null) {
    run("git", ["-C", wt, "reset", "--hard", remote]);
  }
  run("git", ["-C", wt, "clean", "-fd"]);
}

// Pushes the worktree's head as the issue's branch for `op`, recording the
// push first.
function pushBranch(cfg: Config, n: number, wt: string, op: string): void {
  const target = `HEAD:refs/heads/${paths.branch(n)}`;
  recordPush(cfg, n, head(wt), op);
  git(cfg, ["-C", wt, "push", "--force-with-lease", "origin", target]);
}

// The conflicting rebase's files. Unless kept, the rebase is aborted.
function conflictReply(wt: string, base: string, keep: boolean): SyncConflict {
  const conflicts = unmergedFiles(wt);
  const inRebase = keep && rebaseInProgress(wt);
  if (!inRebase) {
    run("git", ["-C", wt, "rebase", "--abort"], { allowFail: true });
  }
  return {
    changed: false,
    conflict: true,
    inRebase,
    conflicts,
    baseSha: gitOut(wt, ["rev-parse", base]).trim(),
  };
}

// With keepConflict, a conflicting rebase is left stopped in the worktree for a
// writer to resolve; finish-sync then checks the result and pushes it.
function syncBase(cfg: Config, request: unknown): SyncReply {
  const req = parseRequest(SYNC_REQUEST, "sync-base", request);
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) {
    resetToRemote(cfg, n); // left over from a crashed run
  }
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const base = `origin/${cfg.baseBranch}`;
  if (gitSucceeds(wt, ["merge-base", "--is-ancestor", base, "HEAD"])) {
    return { changed: false, conflict: false, headSha: head(wt) };
  }
  const before = head(wt);
  if (!gitSucceeds(wt, ["rebase", base])) {
    return conflictReply(wt, base, req.keepConflict === true);
  }
  try {
    pushBranch(cfg, n, wt, "sync-base");
  } catch (error: unknown) {
    // A deferred sync then retries from the head it pushed last, not from an
    // unpushed rebase.
    run("git", ["-C", wt, "reset", "--hard", before]);
    throw error;
  }
  return { changed: true, conflict: false, headSha: head(wt) };
}

// After a writer resolved a kept rebase: push it if it passes the checks.
// Anything else (or abort: true) resets the worktree to the pushed branch and
// reports why.
function finishSync(cfg: Config, request: unknown): FinishReply {
  const req = parseRequest(FINISH_REQUEST, "finish-sync", request);
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  let reason: string | undefined;
  if (req.abort === true) {
    reason = textOr(req.reason, "aborted");
  } else {
    reason = rebaseProblem(wt, `origin/${cfg.baseBranch}`);
  }
  if (reason !== undefined) {
    resetToRemote(cfg, n);
    return { resolved: false, reason };
  }
  pushBranch(cfg, n, wt, "finish-sync");
  return { resolved: true, headSha: head(wt) };
}

const syncOps: Readonly<Record<string, Op>> = {
  "prepare-review": prepareReview,
  "sync-base": syncBase,
  "finish-sync": finishSync,
};

export { syncOps };
