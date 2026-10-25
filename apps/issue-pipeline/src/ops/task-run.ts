// What every task effect and reconciliation op reads first, fresh in the
// ops child: the work item's task evidence and the run the request names.
// An effect runs only for its own action's recorded, unsettled attempt of
// exactly the requested binding; a reconciliation only for the binding's
// unsettled run, which it settles as that original run.

import { z } from "zod";
import { ensureClone } from "../checkouts.ts";
import type { Config } from "../config.ts";
import type { Binding, Receipt, TaskId, Verdict } from "../domain.ts";
import { BINDING, MAX_SUMMARY, UUID } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import type { Attempt, Records, Row } from "../tasks/records.ts";
import { statusOf } from "../tasks/records.ts";
import type { TaskEvidence } from "../tasks/view.ts";
import { taskEvidence } from "../tasks/view.ts";
import { freshRecords, settleRun } from "./task-ledger.ts";

const EFFECT_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: z.looseObject({ id: UUID }),
});
const EVIDENCE = z.json();
const RECONCILE_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  reconciler: UUID,
});

interface OpenRun {
  cfg: Config;
  number: number;
  binding: Binding;
  attempt: Row<Attempt>;
  evidence: TaskEvidence;
}

interface EffectOutcome {
  verdict: Verdict;
  reason: string;
  produced?: string;
}

function refuse(op: string, reason: string): never {
  throw new OpsError(`${op} refused: ${reason}`);
}

function itemBinding(
  cfg: Config,
  req: { number: number; binding: Binding },
  task: TaskId,
  op: string,
): void {
  const { number, binding } = req;
  if (
    binding.task !== task ||
    binding.workItem.number !== number ||
    binding.workItem.repo.toLowerCase() !== cfg.repo.toLowerCase()
  ) {
    refuse(op, `the binding is not a ${task} binding of #${number}`);
  }
}

// The unsettled latest attempt of `binding`, or a refusal.
function unsettledAttempt(
  records: Records,
  binding: Binding,
  op: string,
): Row<Attempt> {
  const status = statusOf(records.rows, binding);
  if (status.status !== "unknown") {
    refuse(op, `the binding's latest run is ${status.status}, not unsettled`);
  }
  return status.attempt;
}

// This action's own unsettled attempt of the requested binding.
function openRun(
  cfg: Config,
  request: unknown,
  task: TaskId,
  op: string,
): OpenRun {
  const req = parseRequest(EFFECT_REQUEST, op, request);
  itemBinding(cfg, req, task, op);
  if (cfg.execution?.instance !== req.run.id) {
    refuse(op, "an effect runs only under its own action's execution");
  }
  const evidence = taskEvidence(cfg, req.number, ensureClone(cfg));
  const attempt = unsettledAttempt(evidence.records, req.binding, op);
  if (attempt.run.id !== req.run.id) {
    refuse(op, `run ${req.run.id} is not the binding's unsettled run`);
  }
  return {
    cfg,
    number: req.number,
    binding: req.binding,
    attempt,
    evidence,
  };
}

// The binding's original unsettled run, for a read-only reconciliation by
// action `reconciler`.
function openReconciliation(
  cfg: Config,
  request: unknown,
  task: TaskId,
  op: string,
): OpenRun & { reconciler: string } {
  const req = parseRequest(RECONCILE_REQUEST, op, request);
  itemBinding(cfg, req, task, op);
  if (cfg.execution?.instance !== req.reconciler) {
    refuse(op, "a reconciliation runs only under its own action's execution");
  }
  const evidence = taskEvidence(cfg, req.number, ensureClone(cfg));
  const attempt = unsettledAttempt(evidence.records, req.binding, op);
  return {
    cfg,
    number: req.number,
    binding: req.binding,
    attempt,
    evidence,
    reconciler: req.reconciler,
  };
}

// Records `outcome` as the open run's verdict, read fresh, and returns it.
function settled(
  run: OpenRun,
  outcome: EffectOutcome,
  evidence?: object,
): EffectOutcome {
  if (outcome.verdict === "unknown") {
    return outcome;
  }
  const receipt: Receipt = { summary: outcome.reason.slice(0, MAX_SUMMARY) };
  if (outcome.produced !== undefined) {
    receipt.produced = { code: outcome.produced };
  }
  if (evidence !== undefined) {
    receipt.evidence = EVIDENCE.parse(evidence);
  }
  settleRun(run.cfg, run.number, freshRecords(run.cfg, run.number), {
    attempt: run.attempt,
    verdict: outcome.verdict,
    receipt,
  });
  return outcome;
}

export type { EffectOutcome, OpenRun };
export { openReconciliation, openRun, refuse, settled };
