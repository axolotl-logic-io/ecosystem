// The verified release predicate (#151): when a stage job may relinquish
// issue-execution ownership. A run ending releases nothing on its own
// (capacity-by-resource). The job releases only when its run reached an end
// with a confirmed checkpoint, nothing it did is left uncertain, teardown
// preserved its work and removed its checkout, and no registered consumer
// still needs the issue's lane slot. Anything else holds for reconciliation
// by reading (runs-and-retries); an unknown fact never counts as success
// (observation-sources). This gates execution release only: a lane slot is
// still released by checkout removal (lane-slots.ts), never by this.

import type { Config } from "../config.ts";
import { assertReconciled } from "../execution.ts";
import { registeredConsumers } from "../lane-slots.ts";
import { assertStopRecoveryResolved } from "../stop-recovery.ts";
import type { OpsReply, RunOp } from "./ops-request.ts";
import type { RunEnd } from "./teardown.ts";

// The ops that write the issue's saved state, its checkpoint. A failed
// reply leaves the write uncertain: it may have landed.
const CHECKPOINT_OPS = new Set([
  "claim",
  "save-state",
  "release",
  "ask",
  "stop",
]);

// What the job observed of its own run, for the predicate.
interface ReleaseEvidence {
  end: RunEnd | null;
  // The checkpoint writes whose reply failed, in order.
  unresolved: readonly string[];
  // Whether teardown preserved the checkout's work and removed it.
  preserved: boolean;
}

// The job's op runner, which also records each checkpoint write whose
// reply failed.
interface CheckpointLedger {
  runOp: RunOp;
  unresolved: () => readonly string[];
}

function checkpointLedger(runOp: RunOp): CheckpointLedger {
  const unresolved: string[] = [];
  return {
    runOp: async (
      op: string,
      payload: object,
      minutes?: number,
    ): Promise<OpsReply> => {
      const reply = await runOp(op, payload, minutes);
      if (!reply.ok && CHECKPOINT_OPS.has(op)) {
        unresolved.push(op);
      }
      return reply;
    },
    unresolved: (): readonly string[] => [...unresolved],
  };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Why `check` refuses, or null when it passes.
function refusalOf(check: () => void): string | null {
  try {
    check();
    return null;
  } catch (error: unknown) {
    return messageOf(error);
  }
}

// Why the run's own end refuses release, or null.
function endRefusal(evidence: ReleaseEvidence): string | null {
  const { end, unresolved, preserved } = evidence;
  if (end === null) {
    return "the run ended without an outcome";
  }
  if (end.kind === "finished" && end.summary.claimError !== undefined) {
    return `the claim refused: ${end.summary.claimError}`;
  }
  if (unresolved.length > 0) {
    return `unresolved checkpoint write: ${unresolved.join(", ")}`;
  }
  if (!preserved) {
    return "teardown didn't preserve and remove the checkout";
  }
  return null;
}

// Throws while a registered consumer, another surviving checkout or a
// pending setup, still holds issue `issue`'s lane slot.
function assertNoConsumer(cfg: Config, issue: number): void {
  const consumers = registeredConsumers(cfg, issue, null);
  if (consumers.length > 0) {
    throw new Error(
      `the lane slot still has registered consumers: ${consumers.join(", ")}`,
    );
  }
}

// Why issue `issue`'s execution must hold after a run with `evidence`, or
// null when the job may release it.
function releaseRefusal(
  cfg: Config,
  issue: number,
  evidence: ReleaseEvidence,
): string | null {
  return (
    endRefusal(evidence) ??
    refusalOf((): void => assertStopRecoveryResolved(cfg, issue)) ??
    refusalOf((): void => assertReconciled(cfg, issue)) ??
    refusalOf((): void => assertNoConsumer(cfg, issue))
  );
}

export type { CheckpointLedger, ReleaseEvidence };
export { checkpointLedger, releaseRefusal };
