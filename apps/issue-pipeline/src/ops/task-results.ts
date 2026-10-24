// The task-result ops (#183; docs/reference/task-results.md): a read of one
// binding's status, and the landing account's append of an attempt or a
// result. Each append reads the records fresh, checks that the new record
// keeps them consistent, posts it, and reads them back to confirm it.
// Inactive until #180's activation: no role's OpName names these ops.

import { z } from "zod";
import { listComments, rawComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import type {
  Binding,
  Result,
  Row,
  TaskRecord,
  TaskStatus,
} from "../task-result-records.ts";
import {
  BINDING,
  RECEIPT,
  RUN_ID,
  recordBody,
  requestedBinding,
  TaskResultsHold,
  VERDICT,
} from "../task-result-records.ts";
import {
  checkedRows,
  statusIn,
  taskRecords,
  taskStatus,
} from "../task-results.ts";

const STATUS_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  binding: BINDING,
});

const ATTEMPT_REQUEST = STATUS_REQUEST.extend({
  run: z.strictObject({ id: RUN_ID, previous: RUN_ID.nullable() }),
});

const RESULT_REQUEST = STATUS_REQUEST.extend({
  run: z.strictObject({ id: RUN_ID }),
  verdict: VERDICT,
  receipt: RECEIPT,
});

interface ResultReply {
  status: TaskStatus;
}

interface AttemptReply extends ResultReply {
  attempt: number;
}

// Above every comment id GitHub has given, so a proposed record sorts last.
const PROPOSED_ID: number = Number.MAX_SAFE_INTEGER;

function taskResult(cfg: Config, request: unknown): TaskStatus {
  const req = parseRequest(STATUS_REQUEST, "task-result", request);
  const binding = requestedBinding(cfg, req.number, req.binding);
  return taskStatus(cfg, req.number, listComments(cfg, req.number), binding);
}

// The records with `record` appended, checked as the next reader will check
// them; a record that would make them hold is refused before it's written.
function withProposed(cfg: Config, number: number, record: TaskRecord): Row[] {
  const rows = taskRecords(cfg, number, listComments(cfg, number));
  return checkedRows([...rows, { ...record, id: PROPOSED_ID }]);
}

// Posts `record` and confirms it by a fresh read. A read that can't confirm
// it leaves the record uncertain: the next caller reconciles by reading and
// never repeats the append.
function appended(cfg: Config, number: number, record: TaskRecord): Row[] {
  rawComment(cfg, number, recordBody(record));
  let rows: Row[];
  try {
    rows = taskRecords(cfg, number, listComments(cfg, number));
  } catch (error) {
    throw new OpsError(
      `the recorded ${record.kind} is uncertain; reconcile by reading before any retry`,
      { cause: error },
    );
  }
  const mine = rows.filter(
    (row) => row.kind === record.kind && row.run.id === record.run.id,
  );
  if (mine.length === 0) {
    throw new OpsError(
      `the recorded ${record.kind} is not readable; reconcile by reading before any retry`,
    );
  }
  return rows;
}

// Appends an attempt of `run` for `binding`, only when the binding is missing.
function startAttempt(
  cfg: Config,
  number: number,
  binding: Binding,
  run: { id: string; previous: string | null },
): AttemptReply {
  const before = taskStatus(cfg, number, listComments(cfg, number), binding);
  if (before.status !== "missing") {
    throw new OpsError(`no attempt may start: the binding is ${before.status}`);
  }
  const record: TaskRecord = { version: 1, kind: "attempt", binding, run };
  holdsAsRefusal(() => withProposed(cfg, number, record));
  const rows = appended(cfg, number, record);
  return { attempt: before.attempts + 1, status: statusIn(rows, binding) };
}

// Appends `run`'s verdict for `binding`, if it keeps the records consistent.
function appendResult(
  cfg: Config,
  number: number,
  result: Omit<Result, "version" | "kind">,
): ResultReply {
  const record: TaskRecord = { version: 1, kind: "result", ...result };
  holdsAsRefusal(() => withProposed(cfg, number, record));
  const rows = appended(cfg, number, record);
  return { status: statusIn(rows, result.binding) };
}

function recordTaskAttempt(cfg: Config, request: unknown): AttemptReply {
  const req = parseRequest(ATTEMPT_REQUEST, "record-task-attempt", request);
  const binding = requestedBinding(cfg, req.number, req.binding);
  return startAttempt(cfg, req.number, binding, req.run);
}

function recordTaskResult(cfg: Config, request: unknown): ResultReply {
  const req = parseRequest(RESULT_REQUEST, "record-task-result", request);
  const binding = requestedBinding(cfg, req.number, req.binding);
  return appendResult(cfg, req.number, {
    binding,
    run: req.run,
    verdict: req.verdict,
    receipt: req.receipt,
  });
}

// A record that would make the records hold is refused, with why.
function holdsAsRefusal(check: () => unknown): void {
  try {
    check();
  } catch (error) {
    if (error instanceof TaskResultsHold) {
      throw new OpsError(`refused: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

const taskResultOps: Readonly<
  Record<string, (cfg: Config, request: unknown) => object>
> = {
  "task-result": taskResult,
  "record-task-attempt": recordTaskAttempt,
  "record-task-result": recordTaskResult,
};

export type { AttemptReply, ResultReply };
export { appendResult, startAttempt, taskResultOps };
