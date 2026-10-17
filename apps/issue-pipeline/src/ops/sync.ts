// The issue branch against its base: prepare-review writes the diff a review
// reads, sync-base rebases the branch onto the moved base, and finish-sync
// checks a rebase a writer resolved against the base sync-base rebased onto
// and pushes it. A stacked branch (stack.ts) is measured against, and rebased
// onto, its prerequisite's branch instead; only a stacked sync-base reads
// GitHub, to learn whether that has merged.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { BranchChanges } from "../checkouts.ts";
import { branchChanges, recordPush } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertClean, fetchIn, head, remoteHead } from "../git-state.ts";
import { git } from "../github.ts";
import { parseRequest, run } from "../process.ts";
import { abortRebase, rebaseInProgress, unmergedFiles } from "../rebase.ts";
import type { StackedOn, SyncTarget } from "../stack.ts";
import { measureFrom, STACKED_ON, syncTarget } from "../stack.ts";
import { commitLog, withWiki } from "./review-diff.ts";
import { finishProblem } from "./sync-finish.ts";

// headTree is the head's tree, the same for any head with the same code.
interface ReviewReply {
  headSha: string;
  headTree: string;
  baseSha: string;
  diffPath: string;
  diffLines: number;
  changedFiles: string[];
}

// A stacked sync's reply names what the branch is stacked on after it; an
// unstacked one has no stackedOn.
interface Stacked {
  stackedOn?: StackedOn | null;
}

type SyncReply =
  | ({ changed: boolean; conflict: false; headSha: string } & BranchChanges &
      Stacked)
  | SyncConflict;

interface SyncConflict extends Stacked {
  changed: false;
  conflict: true;
  inRebase: boolean;
  conflicts: string[];
  baseSha: string;
}

type FinishReply =
  | { resolved: false; reason: string }
  | ({ resolved: true; headSha: string } & BranchChanges);

type Op = (
  cfg: Config,
  request: unknown,
) => ReviewReply | SyncReply | FinishReply;

const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;

const REVIEW_REQUEST = z.looseObject({
  number: z.number().int(),
  sinceSha: z.string().nullish(),
  tag: z.string().nullish(),
  stackedOn: STACKED_ON.nullish(),
});
const SYNC_REQUEST = z.looseObject({
  number: z.number().int(),
  keepConflict: z.boolean().nullish(),
  stackedOn: STACKED_ON.nullish(),
});
const FINISH_REQUEST = z.looseObject({
  number: z.number().int(),
  abort: z.boolean().nullish(),
  reason: z.string().nullish(),
  // The commit sync-base rebased onto (its reply's baseSha), #279.
  baseSha: z.string().regex(COMMIT_SHA).nullish(),
  stackedOn: STACKED_ON.nullish(),
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

function prepareReview(cfg: Config, request: unknown): ReviewReply {
  const req = parseRequest(REVIEW_REQUEST, "prepare-review", request);
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  fetchIn(cfg, wt, cfg.baseBranch);
  const headSha = head(wt);
  const headTree = gitOut(wt, ["rev-parse", `${headSha}^{tree}`]).trim();
  const baseArgs = ["merge-base", measureFrom(req.stackedOn, cfg), "HEAD"];
  const baseSha = gitOut(wt, baseArgs).trim();
  const from = reviewFrom(wt, req.sinceSha, { headSha, baseSha });
  const range = `${from}..${headSha}`;
  const patch = gitOut(wt, ["diff", "--stat", "--patch", range]);
  const diff = `${commitLog(wt, range)}${patch}`;
  const names = gitOut(wt, ["diff", "--name-only", `${baseSha}..${headSha}`]);
  const tag = `review-${textOr(req.tag, "r0")}`;
  const dir = path.join(paths.runDir(cfg, n), tag);
  fs.mkdirSync(dir, { recursive: true });
  const diffPath = path.join(dir, "diff.patch");
  const full = withWiki(cfg, n, diff);
  fs.writeFileSync(diffPath, full.text);
  return {
    headSha,
    headTree,
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

// The reply's stackedOn for a sync of a branch that was stacked when the
// request came; nothing for one that wasn't.
function stackedReply(
  stacked: StackedOn | null | undefined,
  target: SyncTarget,
): Stacked {
  if (stacked === null || stacked === undefined) {
    return {};
  }
  return { stackedOn: target.stackedOn };
}

// The conflicting rebase's files. Unless kept, the rebase is aborted.
function conflictReply(
  wt: string,
  onto: string,
  keep: boolean,
): Omit<SyncConflict, "stackedOn"> {
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
    baseSha: gitOut(wt, ["rev-parse", onto]).trim(),
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
  const target = syncTarget(cfg, wt, req.stackedOn);
  const stacked = stackedReply(req.stackedOn, target);
  const { onto, upstream } = target;
  if (gitSucceeds(wt, ["merge-base", "--is-ancestor", onto, "HEAD"])) {
    const changes = branchChanges(cfg, n);
    const headSha = head(wt);
    return { changed: false, conflict: false, headSha, ...changes, ...stacked };
  }
  const before = head(wt);
  if (!gitSucceeds(wt, ["rebase", "--onto", onto, upstream])) {
    const keep = req.keepConflict === true;
    return { ...conflictReply(wt, onto, keep), ...stacked };
  }
  try {
    pushBranch(cfg, n, wt, "sync-base");
  } catch (error: unknown) {
    // A deferred sync then retries from the head it pushed last, not from an
    // unpushed rebase.
    run("git", ["-C", wt, "reset", "--hard", before]);
    throw error;
  }
  const changes = branchChanges(cfg, n);
  return {
    changed: true,
    conflict: false,
    headSha: head(wt),
    ...changes,
    ...stacked,
  };
}

// After a writer resolved a kept rebase: push it if it passes the checks
// against the base sync-base rebased onto (the request's baseSha, else the
// base branch as fetched). Anything else (or abort: true) resets the worktree
// to the pushed branch and reports why.
function finishSync(cfg: Config, request: unknown): FinishReply {
  const req = parseRequest(FINISH_REQUEST, "finish-sync", request);
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  let reason: string | undefined;
  if (req.abort === true) {
    reason = textOr(req.reason, "aborted");
  } else {
    reason = finishProblem(cfg, wt, req);
  }
  if (reason !== undefined) {
    resetToRemote(cfg, n);
    return { resolved: false, reason };
  }
  pushBranch(cfg, n, wt, "finish-sync");
  return { resolved: true, headSha: head(wt), ...branchChanges(cfg, n) };
}

const syncOps: Readonly<Record<string, Op>> = {
  "prepare-review": prepareReview,
  "sync-base": syncBase,
  "finish-sync": finishSync,
};

export { syncOps };
