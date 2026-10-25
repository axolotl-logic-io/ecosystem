// Sync's effects and its read-only reconciliation, on the v2 records. The
// rebase, its gitlink refusal, conflict handling, retired-submodule
// recovery and work preservation are the installed sync's own (rebase.ts,
// code-recovery.ts, sync-finish.ts). Branch effects use the development
// account; the landing account records the run.
//
//   sync-task        this action's own Sync attempt: rebase R onto exactly
//                    T in the action's checkout. A text stop stays in the
//                    checkout for one resolver session.
//   sync-task-finish continue the resolved stop, or retain or reject it
//   sync-reconcile   settle an interrupted run as its original run, from
//                    the branch and checkout alone; never push or rebase:
//       branch at a new head containing T, checkout there → passed
//       branch at R, checkout rebased past R → push never landed: the
//           rebased work is kept in recovery, back to R, failed
//       branch at R, nothing changed → failed
//       a stopped rebase, or anything else → held (unknown)

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertClean, head, remoteHead } from "../git-state.ts";
import { retainSyncConflict } from "../job/code-recovery.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import {
  classifyCodeSync,
  clearCodeSync,
  continueCodeSync,
  readCodeSync,
  rebaseInProgress,
  rebaseProblem,
  saveCodeSync,
  unmergedFiles,
} from "../rebase.ts";
import { retireSubmodules } from "../retired-submodules.ts";
import { MODULES } from "../tasks/modules.ts";
import { isAncestor } from "../tasks/view.ts";
import { pushBranch, resetToRemote } from "./sync-finish.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openReconciliation, openRun, refuse, settled } from "./task-run.ts";

const FINISH = z.looseObject({
  cannotFix: z.boolean().optional(),
  retainConflict: z.boolean().optional(),
  reason: z.string().min(1).optional(),
});

type SyncReply = EffectOutcome | { conflict: true; conflicts: string[] };

interface SyncRun {
  run: OpenRun;
  wt: string;
  from: string;
  target: string;
}

function syncOf(open: OpenRun): SyncRun {
  if (!("revision" in open.binding)) {
    throw new OpsError("a Sync binding binds a revision");
  }
  return {
    run: open,
    wt: paths.worktree(open.cfg, open.number),
    from: open.binding.revision.code,
    target: open.binding.target.commit,
  };
}

// The finished rebase, pushed, then checked on the branch itself: it holds
// exactly the pushed head, a new head containing exactly T.
function completed(sync: SyncRun): EffectOutcome {
  const { run: open, wt, from, target } = sync;
  const { cfg, number } = open;
  retireSubmodules(cfg, number, wt, from);
  const problem = rebaseProblem(wt, target);
  if (problem !== undefined) {
    resetToRemote(cfg, number, problem);
    return settled(open, { verdict: "failed", reason: problem });
  }
  const local = head(wt);
  pushBranch(cfg, number, wt, "sync-task");
  const remote = remoteHead(cfg, number);
  if (remote !== local || local === from || !isAncestor(wt, target, local)) {
    return {
      verdict: "unknown",
      reason: `the Sync push left the branch at ${remote ?? "none"}; reconcile by reading`,
    };
  }
  clearCodeSync(wt);
  return settled(open, {
    verdict: "passed",
    reason: `rebased ${from} onto ${target} as ${local}`,
    produced: local,
  });
}

function stopped(sync: SyncRun): SyncReply {
  if (rebaseInProgress(sync.wt)) {
    return { conflict: true, conflicts: unmergedFiles(sync.wt) };
  }
  return completed(sync);
}

function syncTask(cfg: Config, request: unknown): SyncReply {
  const open = openRun(cfg, request, "sync", "sync-task");
  const unmet = MODULES.sync.prerequisite(cfg, open.evidence, open.binding);
  if (unmet !== null) {
    return settled(open, {
      verdict: "failed",
      reason: `nothing synced: ${unmet}`,
    });
  }
  const sync = syncOf(open);
  const { wt, from, target } = sync;
  if (rebaseInProgress(wt) || readCodeSync(wt) !== undefined) {
    return settled(open, {
      verdict: "failed",
      reason: "a retained synchronization is in the checkout; reconcile it",
    });
  }
  assertClean(wt);
  if (head(wt) !== from) {
    return settled(open, {
      verdict: "failed",
      reason: `the checkout is not at revision ${from}`,
    });
  }
  saveCodeSync(wt, { from, onto: target });
  run("git", ["-C", wt, "rebase", target], { allowFail: true });
  continueCodeSync(wt);
  return stopped(sync);
}

function syncTaskFinish(cfg: Config, request: unknown): EffectOutcome {
  const open = openRun(cfg, request, "sync", "sync-task-finish");
  const req = FINISH.parse(request);
  const sync = syncOf(open);
  if (classifyCodeSync(sync.wt, sync.target) === undefined) {
    refuse(
      "sync-task-finish",
      "no synchronization of this run is in the checkout",
    );
  }
  if (req.retainConflict === true) {
    const reason = req.reason ?? "the resolver's allowance is spent";
    return settled(open, {
      verdict: "failed",
      reason: retainSyncConflict(cfg, open.number, sync.wt, reason),
    });
  }
  if (req.cannotFix === true) {
    const reason = req.reason ?? "the resolver could not fix the conflicts";
    resetToRemote(cfg, open.number, reason);
    return settled(open, { verdict: "failed", reason });
  }
  continueCodeSync(sync.wt);
  if (rebaseInProgress(sync.wt)) {
    const reason = "the resolver left the rebase stopped";
    return settled(open, {
      verdict: "failed",
      reason: retainSyncConflict(cfg, open.number, sync.wt, reason),
    });
  }
  return completed(sync);
}

function reconciled(sync: SyncRun): EffectOutcome {
  const { run: open, wt, from, target } = sync;
  const remote = remoteHead(open.cfg, open.number);
  const local = head(wt);
  const syncing = readCodeSync(wt) !== undefined;
  if (remote === local && local !== from && isAncestor(wt, target, local)) {
    clearCodeSync(wt);
    return {
      verdict: "passed",
      reason: `reconciled: the branch holds ${local}, containing ${target}`,
      produced: local,
    };
  }
  if (remote === from && local === from && !syncing) {
    return { verdict: "failed", reason: "reconciled: no effect was made" };
  }
  if (remote === from && syncing && local !== from) {
    const reason = `reconciled: the push of ${local} never landed; the rebased work is kept in recovery`;
    resetToRemote(open.cfg, open.number, reason);
    return { verdict: "failed", reason };
  }
  return {
    verdict: "unknown",
    reason: `the branch is at ${remote ?? "none"} and the checkout at ${local}; the run stays held`,
  };
}

function syncReconcile(cfg: Config, request: unknown): EffectOutcome {
  const open = openReconciliation(cfg, request, "sync", "sync-reconcile");
  const sync = syncOf(open);
  if (rebaseInProgress(sync.wt)) {
    return {
      verdict: "unknown",
      reason:
        "a stopped rebase is retained in the checkout; a person recovers it",
    };
  }
  return settled(open, reconciled(sync), { reconciledBy: open.reconciler });
}

export { syncReconcile, syncTask, syncTaskFinish };
