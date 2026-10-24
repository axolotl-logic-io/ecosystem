// Settles a Sync run that ended without a verdict (#184; `runs-and-retries`
// rule 3): it reads the branch and the checkout, never repeats the push or
// the rebase, and records only what it can establish. Anything it can't
// account for stays unsettled and holds, with the checkout retained.
//
//   branch at a new head H containing T, checkout at H → the push landed: passed
//   branch still at R, checkout rebased past R → the push never landed:
//       save the rebased work as recovery, back to R, failed
//   branch still at R, nothing changed → interrupted before any effect: failed
//   a stopped rebase in the checkout → retained for a person or a finish
//   anything else → held

import { z } from "zod";
import type { Config } from "../config.ts";
import { head, remoteHead } from "../git-state.ts";
import { parseRequest } from "../process.ts";
import { clearCodeSync, readCodeSync, rebaseInProgress } from "../rebase.ts";
import { BINDING, RUN_ID } from "../task-result-records.ts";
import { statusIn } from "../task-results.ts";
import { resetToRemote } from "./sync-finish.ts";
import { contains, refuse, syncGate } from "./sync-task-gate.ts";
import { appendResult } from "./task-results.ts";

const RECONCILE_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: z.strictObject({ id: RUN_ID }),
});

type ReconcileReply =
  | { settled: "passed"; produced: string }
  | { settled: "failed"; reason: string }
  | { settled: false; reason: string };

function syncTaskReconcile(cfg: Config, request: unknown): ReconcileReply {
  const req = parseRequest(RECONCILE_REQUEST, "sync-task-reconcile", request);
  const { binding, rows, wt } = syncGate(cfg, req.number, req.binding);
  const status = statusIn(rows, binding);
  if (status.status !== "unknown" || status.run !== req.run.id) {
    refuse(`run ${req.run.id} is not this binding's unsettled run`);
  }
  if (rebaseInProgress(wt)) {
    return {
      settled: false,
      reason:
        "a stopped rebase is retained in the checkout; finish or retain it, or a person recovers it",
    };
  }
  const from = binding.revision.code;
  const target = binding.target.commit;
  const remote = remoteHead(cfg, req.number);
  const local = head(wt);
  const syncing = readCodeSync(wt) !== undefined;
  /** The verdict for this run, as the records will hold it. */
  function settle(
    verdict: "passed" | "failed",
    receipt: { summary: string; produced?: { code: string } },
  ): void {
    appendResult(cfg, req.number, {
      binding,
      run: { id: req.run.id },
      verdict,
      receipt,
    });
  }
  if (remote === local && local !== from && contains(wt, local, target)) {
    clearCodeSync(wt);
    settle("passed", {
      summary: `reconciled: the branch holds ${local}, containing ${target}`,
      produced: { code: local },
    });
    return { settled: "passed", produced: local };
  }
  if (remote === from && local === from && !syncing) {
    const reason = "reconciled: the run ended before any effect";
    settle("failed", { summary: reason });
    return { settled: "failed", reason };
  }
  if (remote === from && syncing && local !== from) {
    const reason = `reconciled: the push of ${local} never landed; the rebased work is kept in recovery`;
    resetToRemote(cfg, req.number, reason);
    settle("failed", { summary: reason });
    return { settled: "failed", reason };
  }
  return {
    settled: false,
    reason: `the branch is at ${remote ?? "none"} and the checkout at ${local}; neither is accounted for, so the run stays held`,
  };
}

const syncReconcileOps: Readonly<
  Record<string, (cfg: Config, request: unknown) => ReconcileReply>
> = { "sync-task-reconcile": syncTaskReconcile };

export { syncReconcileOps };
