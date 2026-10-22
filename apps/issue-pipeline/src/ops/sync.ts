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
import { retainSyncConflict, saveSyncRecovery } from "../job/code-recovery.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
import {
  classifyCodeSync,
  clearCodeSync,
  continueCodeSync,
  rebaseInProgress,
  removeRetiredSubmodules,
  saveCodeSync,
  unmergedFiles,
} from "../rebase.ts";
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
  | SyncConflict
  | { resolved: false; reason: string; retained?: true }
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
  cannotFix: z.boolean().nullish(),
  retainConflict: z.boolean().nullish(),
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

// Rebase onto the base and continue automatically, refusing gitlink conflicts.
// With keepConflict, remaining text stops stay for a writer to stage;
// finish-sync continues and checks them.
function syncBase(cfg: Config, request: unknown): SyncReply {
  const req = parseRequest(SYNC_REQUEST, "sync-base", request);
  const n = req.number;
  refuseOnceMerged(cfg, n, "sync-base");
  const wt = paths.worktree(cfg, n);
  if (rebaseInProgress(wt)) {
    // A crashed run can leave a later stop reached by a resolver session.
    // Apply the same classification before deciding whether cleanup is safe.
    classifyCodeSync(wt, undefined);
    resetToRemote(cfg, n);
  }
  assertClean(wt);
  fetchIn(cfg, wt, cfg.baseBranch);
  const onto = gitOut(wt, ["rev-parse", `origin/${cfg.baseBranch}`]).trim();
  if (gitSucceeds(wt, ["merge-base", "--is-ancestor", onto, "HEAD"])) {
    const changes = branchChanges(cfg, n);
    return { changed: false, conflict: false, headSha: head(wt), ...changes };
  }
  const before = head(wt);
  const sync = { from: before, onto };
  saveCodeSync(wt, sync);
  const rebased = gitSucceeds(wt, ["rebase", onto]);
  if (!(rebased || rebaseInProgress(wt))) {
    throw new OpsError(
      "code rebase failed without a stopped rebase; retaining checkout",
    );
  }
  if (!rebased) {
    continueCodeSync(wt);
  }
  if (rebaseInProgress(wt)) {
    return conflictReply(wt, onto, req.keepConflict === true);
  }
  removeRetiredSubmodules(wt, before);
  try {
    pushBranch(cfg, n, wt, "sync-base");
  } catch (error: unknown) {
    // A deferred sync then retries from the head it pushed last, not from an
    // unpushed rebase.
    saveSyncRecovery(cfg, n, wt);
    run("git", ["-C", wt, "reset", "--hard", before]);
    throw error;
  }
  clearCodeSync(wt);
  const changes = branchChanges(cfg, n);
  return {
    changed: true,
    conflict: false,
    headSha: head(wt),
    ...changes,
  };
}

// Continue a staged text stop, returning the next text conflict when necessary.
// Only a finished, checked rebase is pushed. Rejected work is preserved before
// cleanup; an unresolved index refuses destructive cleanup.
function finishSync(cfg: Config, request: unknown): FinishReply {
  const req = parseRequest(FINISH_REQUEST, "finish-sync", request);
  const n = req.number;
  refuseOnceMerged(cfg, n, "finish-sync");
  const wt = paths.worktree(cfg, n);
  const sync = classifyCodeSync(wt, req.baseSha);
  if (req.retainConflict === true) {
    const reason = retainSyncConflict(
      cfg,
      n,
      wt,
      textOr(req.reason, "conflict-fix allowance exhausted"),
    );
    return { resolved: false, retained: true, reason };
  }
  let reason: string | undefined;
  if (req.abort === true) {
    reason = textOr(req.reason, "aborted");
  } else {
    if (sync !== undefined && rebaseInProgress(wt)) {
      continueCodeSync(wt);
      if (rebaseInProgress(wt) && req.cannotFix !== true) {
        return conflictReply(wt, sync.onto, true);
      }
    }
    reason = finishProblem(cfg, n, req);
    if (reason !== undefined && req.cannotFix === true) {
      reason = `${textOr(req.reason, "resolver could not fix conflicts")}; ${reason}`;
    }
  }
  if (reason !== undefined) {
    resetToRemote(cfg, n, reason);
    return { resolved: false, reason };
  }
  pushBranch(cfg, n, wt, "finish-sync");
  clearCodeSync(wt);
  return { resolved: true, headSha: head(wt), ...branchChanges(cfg, n) };
}

const syncOps: Readonly<Record<string, Op>> = {
  "prepare-review": prepareReview,
  "sync-base": syncBase,
  "finish-sync": finishSync,
};

export { syncOps };
