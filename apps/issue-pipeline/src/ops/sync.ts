// The issue branch against its base: prepare-review (prepare-review.ts)
// writes the diff a review reads, sync-base rebases the branch onto the moved
// base, and finish-sync checks a rebase a writer resolved against the base
// sync-base rebased onto and pushes it.

import { z } from "zod";
import type { BranchChanges } from "../checkouts.ts";
import { branchChanges } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertClean, fetchIn, head } from "../git-state.ts";
import { parseRequest, run } from "../process.ts";
import { rebaseInProgress, unmergedFiles } from "../rebase.ts";
import { holdWikiPin } from "../wiki.ts";
import type { ReviewReply } from "./prepare-review.ts";
import { prepareReview } from "./prepare-review.ts";
import { refuseOnceMerged } from "./push.ts";
import { finishProblem, pushBranch, resetToRemote } from "./sync-finish.ts";

type SyncReply =
  | ({ changed: boolean; conflict: false; headSha: string } & BranchChanges)
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
  | ({ resolved: true; headSha: string } & BranchChanges);

type Op = (
  cfg: Config,
  request: unknown,
) => ReviewReply | SyncReply | FinishReply;

const COMMIT_SHA = /^[0-9a-f]{40,64}$/u;

const SYNC_REQUEST = z.looseObject({
  number: z.number().int(),
  keepConflict: z.boolean().nullish(),
});
const FINISH_REQUEST = z.looseObject({
  number: z.number().int(),
  abort: z.boolean().nullish(),
  reason: z.string().nullish(),
  // The commit sync-base rebased onto (its reply's baseSha), #279.
  baseSha: z.string().regex(COMMIT_SHA).nullish(),
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

// The conflicting rebase's files. Unless kept, the rebase is aborted.
function conflictReply(wt: string, onto: string, keep: boolean): SyncConflict {
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
  refuseOnceMerged(cfg, n, "sync-base");
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) {
    resetToRemote(cfg, n); // left over from a crashed run
  }
  holdWikiPin(cfg, wt);
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const onto = `origin/${cfg.baseBranch}`;
  if (gitSucceeds(wt, ["merge-base", "--is-ancestor", onto, "HEAD"])) {
    const changes = branchChanges(cfg, n);
    return { changed: false, conflict: false, headSha: head(wt), ...changes };
  }
  const before = head(wt);
  const rebased = gitSucceeds(wt, ["rebase", onto]);
  if (!rebased) {
    const keep = req.keepConflict === true;
    const conflict = conflictReply(wt, onto, keep);
    // The stopped rebase may have replayed commits that move the wiki pin.
    holdWikiPin(cfg, wt);
    return conflict;
  }
  holdWikiPin(cfg, wt);
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
  };
}

// After a writer resolved a kept rebase: push it if it passes the checks
// against the base sync-base rebased onto (the request's baseSha, else the
// base branch as fetched). Anything else (or abort: true) resets the worktree
// to the pushed branch and reports why.
function finishSync(cfg: Config, request: unknown): FinishReply {
  const req = parseRequest(FINISH_REQUEST, "finish-sync", request);
  const n = req.number;
  refuseOnceMerged(cfg, n, "finish-sync");
  const wt = paths.worktree(cfg, n);
  let reason: string | undefined;
  if (req.abort === true) {
    reason = textOr(req.reason, "aborted");
  } else {
    // The resolver's own rebase --continue may have replayed pin commits.
    holdWikiPin(cfg, wt);
    reason = finishProblem(cfg, n, req);
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
