// The runtime's recording ops for a task action (tasks/index.ts):
//
//   task-attempt  checks the task's prerequisites on fresh evidence, the
//                 binding's budget and record rules, and anything the task
//                 must hold first (Land's integration turn), then records
//                 the attempt before any task effect. Nothing is recorded
//                 when it doesn't admit the action.
//   task-result   records the action's end for its own attempt. A verdict
//                 the task's effect op already recorded is only confirmed;
//                 a task whose effect op owns its verdicts may record here
//                 only an unknown end; a writer's pass must name the
//                 branch's head.

import { z } from "zod";
import { ensureClone } from "../checkouts.ts";
import { rawComment } from "../comments.ts";
import type { Config } from "../config.ts";
import type { Binding, TaskId } from "../domain.ts";
import {
  ACTION_CAUSE,
  BINDING,
  RECEIPT,
  RUN_REF,
  sameBinding,
  UUID,
  VERDICT,
} from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { MODULES } from "../tasks/modules.ts";
import type { Attempt, Records, Row, TaskRecord } from "../tasks/records.ts";
import {
  determined,
  isAttempt,
  RecordsHold,
  recordBody,
  withProposed,
} from "../tasks/records.ts";
import { cancelLandTurn } from "../tasks/turn.ts";
import { exactRemote, taskEvidence } from "../tasks/view.ts";
import { confirmedRecord, freshRecords, settleRun } from "./task-ledger.ts";

const ATTEMPT_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: RUN_REF,
  buddyRun: UUID,
  cause: ACTION_CAUSE,
});
const RESULT_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
  run: z.looseObject({ id: UUID }),
  verdict: VERDICT,
  receipt: RECEIPT,
});

type Admission =
  | { admitted: true }
  | { admitted: false; state: "waiting" | "held"; reason: string };

// Above every comment id GitHub has given, so a proposed record sorts last.
const PROPOSED_ID: number = Number.MAX_SAFE_INTEGER;

function itemOf(cfg: Config, number: number, binding: Binding): void {
  if (
    binding.workItem.number !== number ||
    binding.workItem.repo.toLowerCase() !== cfg.repo.toLowerCase()
  ) {
    throw new OpsError(`the binding is not of #${number} in ${cfg.repo}`);
  }
}

// Why the records would hold with `record` appended, or null.
function recordRefusal(records: Records, record: TaskRecord): string | null {
  try {
    withProposed(records, record, PROPOSED_ID);
    return null;
  } catch (error) {
    if (error instanceof RecordsHold) {
      return error.message;
    }
    throw error;
  }
}

// What may not be recorded, read fresh: held evidence, an unmet
// prerequisite, or a record the next reader would hold on.
function attemptRefusal(
  cfg: Config,
  req: z.infer<typeof ATTEMPT_REQUEST>,
  record: TaskRecord,
): Admission | null {
  const evidence = taskEvidence(cfg, req.number, ensureClone(cfg));
  if (evidence.view.hold !== null) {
    return { admitted: false, state: "held", reason: evidence.view.hold };
  }
  const unmet = MODULES[req.binding.task].prerequisite(
    cfg,
    evidence,
    req.binding,
  );
  if (unmet !== null) {
    return { admitted: false, state: "waiting", reason: unmet };
  }
  const refused = recordRefusal(evidence.records, record);
  if (refused !== null) {
    return { admitted: false, state: "held", reason: refused };
  }
  return null;
}

function taskAttempt(cfg: Config, request: unknown): Admission {
  const req = parseRequest(ATTEMPT_REQUEST, "task-attempt", request);
  itemOf(cfg, req.number, req.binding);
  if (cfg.execution?.instance !== req.run.id) {
    throw new OpsError("an attempt's run is its own action's execution");
  }
  const record: Attempt = {
    version: 2,
    kind: "attempt",
    binding: req.binding,
    run: req.run,
    buddyRun: req.buddyRun,
    cause: req.cause,
  };
  const refusal = attemptRefusal(cfg, req, record);
  if (refusal !== null) {
    return refusal;
  }
  const module = MODULES[req.binding.task];
  const admission = module.admit?.(cfg, req.number) ?? { state: "admitted" };
  if (admission.state !== "admitted") {
    return { admitted: false, ...admission };
  }
  appendAdmitted(cfg, req.number, record, req.binding.task);
  return { admitted: true };
}

// Records the admitted attempt. A refusal before the post gives back what
// the task took; a post whose outcome can't be read keeps it.
function appendAdmitted(
  cfg: Config,
  number: number,
  record: Attempt,
  task: TaskId,
): void {
  const refused = recordRefusal(freshRecords(cfg, number), record);
  if (refused !== null) {
    if (task === "land") {
      cancelLandTurn(cfg, number);
    }
    throw new OpsError(`refused: ${refused}`);
  }
  rawComment(cfg, number, recordBody(record), true);
  confirmedRecord(cfg, number, record);
}

function ownAttempt(
  records: Records,
  run: string,
  binding: Binding,
): Row<Attempt> {
  const attempt = records.rows
    .filter(isAttempt)
    .find((row) => row.run.id === run);
  if (attempt === undefined || !sameBinding(attempt.binding, binding)) {
    throw new OpsError(`run ${run} has no attempt of this binding`);
  }
  return attempt;
}

// A writer's pass names the head now on the item's branch.
function assertProduced(
  cfg: Config,
  number: number,
  produced: string | undefined,
): void {
  const evidence = taskEvidence(cfg, number, ensureClone(cfg));
  const head = exactRemote(
    cfg,
    evidence.clone,
    `refs/heads/${evidence.branch}`,
  );
  if (produced === undefined || head !== produced) {
    throw new OpsError(
      `a writer's pass must name the branch head ${String(head)}, not ${String(produced)}`,
    );
  }
}

function taskResult(
  cfg: Config,
  request: unknown,
): { verdict: string; recorded: boolean } {
  const req = parseRequest(RESULT_REQUEST, "task-result", request);
  itemOf(cfg, req.number, req.binding);
  const records = freshRecords(cfg, req.number);
  const attempt = ownAttempt(records, req.run.id, req.binding);
  const settled = determined(records.rows, attempt.run.id);
  if (settled !== undefined) {
    if (settled.verdict !== req.verdict && req.verdict !== "unknown") {
      throw new OpsError(
        `run ${attempt.run.id} already settled ${settled.verdict}`,
      );
    }
    return { verdict: settled.verdict, recorded: false };
  }
  const module = MODULES[req.binding.task];
  if (module.ownsResult && req.verdict !== "unknown") {
    throw new OpsError(
      `${req.binding.task} records its determined verdicts only in its effect op`,
    );
  }
  if (req.verdict === "passed" && module.writesCode) {
    assertProduced(cfg, req.number, req.receipt.produced?.code);
  }
  settleRun(cfg, req.number, records, {
    attempt,
    verdict: req.verdict,
    receipt: req.receipt,
  });
  return { verdict: req.verdict, recorded: true };
}

export { taskAttempt, taskResult };
