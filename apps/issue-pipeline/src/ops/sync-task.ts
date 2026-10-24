// The Sync task (#184; `sync-is-a-task`): revision R and the exact target T
// in, R′ containing T or a retained stop out. Branch effects use the
// development account (pushBranch); the landing account records the attempt
// and result (#183). The rebase, its gitlink refusal, binary and text
// conflict handling, retired-submodule recovery and work preservation are the
// installed sync's own (rebase.ts, code-recovery.ts, sync-finish.ts).
// The Sync task job (roles/sync/sync.ts) calls them since #186.
//
//   sync-task         check, record the attempt, rebase onto exactly T
//   sync-task-finish  continue a resolved stop, or retain or reject it
//   sync-task-reconcile (sync-task-reconcile.ts) settle an interrupted run

import { z } from "zod";
import type { Config } from "../config.ts";
import { assertClean, head, remoteHead } from "../git-state.ts";
import { retainSyncConflict } from "../job/code-recovery.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
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
import { BINDING, RUN_ID } from "../task-result-records.ts";
import { pushBranch, resetToRemote } from "./sync-finish.ts";
import type { SyncBinding } from "./sync-task-gate.ts";
import { refuse, syncGate } from "./sync-task-gate.ts";
import { contains } from "./task-gate.ts";
import { appendResult, startAttempt } from "./task-results.ts";

const START_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: z.strictObject({ id: RUN_ID, previous: RUN_ID.nullable() }),
});

const FINISH_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: z.strictObject({ id: RUN_ID }),
  cannotFix: z.boolean().optional(),
  retainConflict: z.boolean().optional(),
  reason: z.string().min(1).optional(),
});

type SyncTaskReply =
  | { ready: false; reason: string }
  | { conflict: true; conflicts: string[]; target: string }
  | { verdict: "passed"; produced: string }
  | { verdict: "failed"; reason: string; retained: boolean };

const MAX_SUMMARY = 300;

interface SyncRun {
  cfg: Config;
  number: number;
  binding: SyncBinding;
  run: string;
  wt: string;
}

function failed(
  sync: SyncRun,
  reason: string,
  retained: boolean,
): SyncTaskReply {
  appendResult(sync.cfg, sync.number, {
    binding: sync.binding,
    run: { id: sync.run },
    verdict: "failed",
    receipt: { summary: reason.slice(0, MAX_SUMMARY), evidence: { retained } },
  });
  return { verdict: "failed", reason, retained };
}

// The finished rebase pushed through the development account, then checked
// on the branch itself: the branch holds exactly the pushed head, and that
// head contains the exact requested T. An ancestor the rebase kept is no proof.
function completed(sync: SyncRun): SyncTaskReply {
  const { cfg, number, binding, wt } = sync;
  const from = binding.revision.code;
  const target = binding.target.commit;
  retireSubmodules(cfg, number, wt, from);
  const problem = rebaseProblem(wt, target);
  if (problem !== undefined) {
    resetToRemote(cfg, number, problem);
    return failed(sync, problem, false);
  }
  const local = head(wt);
  pushBranch(cfg, number, wt, "sync-task");
  const remote = remoteHead(cfg, number);
  if (remote !== local || !contains(wt, local, target) || local === from) {
    throw new OpsError(
      `the Sync push left the branch at ${remote ?? "none"}, which isn't a new head containing ${target}; reconcile by reading`,
    );
  }
  clearCodeSync(wt);
  appendResult(cfg, number, {
    binding,
    run: { id: sync.run },
    verdict: "passed",
    receipt: {
      summary: `rebased ${from} onto ${target} as ${local}`,
      produced: { code: local },
    },
  });
  return { verdict: "passed", produced: local };
}

function conflictOf(sync: SyncRun): SyncTaskReply {
  return {
    conflict: true,
    conflicts: unmergedFiles(sync.wt),
    target: sync.binding.target.commit,
  };
}

// Checks R and T, records the attempt, and rebases R onto exactly T. A text
// stop stays in the checkout for a resolver; sync-task-finish continues it.
function syncTask(cfg: Config, request: unknown): SyncTaskReply {
  const req = parseRequest(START_REQUEST, "sync-task", request);
  const { binding, wt } = syncGate(cfg, req.number, req.binding);
  if (rebaseInProgress(wt) || readCodeSync(wt) !== undefined) {
    refuse("a retained synchronization is in the checkout; reconcile it");
  }
  assertClean(wt);
  const from = binding.revision.code;
  const target = binding.target.commit;
  if (head(wt) !== from || remoteHead(cfg, req.number) !== from) {
    refuse(`the checkout and the branch are not both at revision ${from}`);
  }
  if (contains(wt, from, target)) {
    return {
      ready: false,
      reason: `revision ${from} already contains ${target}`,
    };
  }
  startAttempt(cfg, req.number, binding, req.run);
  const sync: SyncRun = {
    cfg,
    number: req.number,
    binding,
    run: req.run.id,
    wt,
  };
  saveCodeSync(wt, { from, onto: target });
  run("git", ["-C", wt, "rebase", target], { allowFail: true });
  continueCodeSync(wt);
  if (rebaseInProgress(wt)) {
    return conflictOf(sync);
  }
  return completed(sync);
}

// The run's stopped rebase after a resolver: continued once its text is
// staged, retained at the resolver's limit, or rejected with its work saved.
function syncTaskFinish(cfg: Config, request: unknown): SyncTaskReply {
  const req = parseRequest(FINISH_REQUEST, "sync-task-finish", request);
  const { binding, rows, wt } = syncGate(cfg, req.number, req.binding);
  const latest = rows
    .filter((row) => row.kind === "attempt" && row.binding.task === "Sync")
    .at(-1);
  if (latest?.run.id !== req.run.id) {
    refuse(`run ${req.run.id} is not the latest Sync attempt`);
  }
  const target = binding.target.commit;
  if (classifyCodeSync(wt, target) === undefined) {
    refuse("no synchronization of this run is in the checkout");
  }
  const sync: SyncRun = {
    cfg,
    number: req.number,
    binding,
    run: req.run.id,
    wt,
  };
  if (req.retainConflict === true) {
    const reason = req.reason ?? "the resolver's allowance is spent";
    return failed(sync, retainSyncConflict(cfg, req.number, wt, reason), true);
  }
  continueCodeSync(wt);
  if (rebaseInProgress(wt) && req.cannotFix !== true) {
    return conflictOf(sync);
  }
  if (req.cannotFix === true) {
    const reason = req.reason ?? "the resolver could not fix the conflicts";
    resetToRemote(cfg, req.number, reason);
    return failed(sync, reason, false);
  }
  return completed(sync);
}

const syncTaskOps: Readonly<
  Record<string, (cfg: Config, request: unknown) => SyncTaskReply>
> = {
  "sync-task": syncTask,
  "sync-task-finish": syncTaskFinish,
};

export type { SyncTaskReply };
export { syncTaskOps };
