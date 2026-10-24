// Revision-bound task results (#183; docs/reference/task-results.md): the
// rules every reader checks across an issue's records, and one binding's
// status. No historical field (state.integration, verifiedSha) ever reads as
// a result. Inactive until #180's activation: no installed role calls the ops.

import type { IssueComment } from "./comments.ts";
import type { Config } from "./config.ts";
import type {
  Attempt,
  Binding,
  Result,
  Row,
  TaskStatus,
} from "./task-result-records.ts";
import {
  hold,
  isAttempt,
  isResult,
  rowOf,
  sameBinding,
  TASK_ATTEMPTS,
  TaskResultsHold,
} from "./task-result-records.ts";

// A run's determined verdict, if its results settled one.
function determined(
  rows: readonly Row[],
  run: string,
): Row<Result> | undefined {
  return rows
    .filter(isResult)
    .find((row) => row.run.id === run && row.verdict !== "unknown");
}

function checkAttempt(rows: readonly Row[], row: Row<Attempt>): void {
  const earlier = rows.filter(isAttempt).filter((item) => item.id < row.id);
  if (earlier.some((item) => item.run.id === row.run.id)) {
    hold(`run ${row.run.id} reused its identity`);
  }
  const same = earlier.filter((item) => sameBinding(item.binding, row.binding));
  const latest = same.at(-1);
  if (latest === undefined) {
    if (
      row.run.previous !== null &&
      !earlier.some(
        (item) =>
          item.run.id === row.run.previous &&
          item.binding.task === row.binding.task,
      )
    ) {
      hold(`run ${row.run.id} links to an unknown predecessor`);
    }
    return;
  }
  if (row.run.previous !== latest.run.id) {
    hold(`run ${row.run.id} does not follow the binding's latest attempt`);
  }
  const before = rows.filter((item) => item.id < row.id);
  const settled = determined(before, latest.run.id);
  if (settled === undefined) {
    hold(`run ${row.run.id} repeated an unsettled attempt`);
  }
  if (settled.verdict !== "failed") {
    hold(`run ${row.run.id} reran a ${settled.verdict} binding`);
  }
}

function checkResult(rows: readonly Row[], row: Row<Result>): void {
  const attempt = rows
    .filter(isAttempt)
    .find((item) => item.id < row.id && item.run.id === row.run.id);
  if (attempt === undefined || !sameBinding(attempt.binding, row.binding)) {
    hold(`result ${row.id} has no attempt with its binding`);
  }
  const before = rows.filter((item) => item.id < row.id);
  if (determined(before, row.run.id) !== undefined) {
    hold(`run ${row.run.id} has conflicting verdicts`);
  }
}

// The issue's records, in order, after checking every rule the reader relies on.
function taskRecords(
  cfg: Pick<Config, "repo" | "mergeAccount">,
  number: number,
  comments: readonly IssueComment[],
): Row[] {
  return checkedRows(
    comments.flatMap((comment) => rowOf(cfg, number, comment)),
  );
}

// `rows` in order, once every rule holds across them.
function checkedRows(unordered: readonly Row[]): Row[] {
  const rows = [...unordered].sort((a, b) => a.id - b.id);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) {
    hold("duplicate record ids");
  }
  for (const row of rows) {
    if (isAttempt(row)) {
      checkAttempt(rows, row);
    } else {
      checkResult(rows, row);
    }
  }
  return rows;
}

// A refused Security subject stays refused under any target or policy: the
// same code and trusted inputs (security-clearance.ts sameSecuritySubject).
function refusedSubject(
  rows: readonly Row[],
  binding: Binding,
): Row<Result> | undefined {
  if (binding.task !== "Security" || !("revision" in binding)) {
    return undefined;
  }
  return rows
    .filter(isResult)
    .find(
      (row) =>
        row.verdict === "refused" &&
        row.binding.task === "Security" &&
        "revision" in row.binding &&
        row.binding.revision.code === binding.revision.code &&
        row.binding.revision.inputs === binding.revision.inputs,
    );
}

function statusIn(rows: readonly Row[], binding: Binding): TaskStatus {
  const attempts = rows
    .filter(isAttempt)
    .filter((row) => sameBinding(row.binding, binding));
  const used = attempts.length;
  const settled = rows
    .filter(isResult)
    .filter(
      (row) => sameBinding(row.binding, binding) && row.verdict !== "unknown",
    );
  const final = settled.find((row) => row.verdict !== "failed");
  if (final !== undefined) {
    const { id: _id, ...result } = final;
    if (final.verdict === "passed") {
      return { status: "passed", result, attempts: used };
    }
    return { status: "refused", result, attempts: used };
  }
  const refused = refusedSubject(rows, binding);
  if (refused !== undefined) {
    const { id: _id, ...result } = refused;
    return { status: "refused", result, attempts: used };
  }
  const latest = attempts.at(-1);
  if (latest !== undefined && determined(rows, latest.run.id) === undefined) {
    return { status: "unknown", run: latest.run.id, attempts: used };
  }
  if (used >= TASK_ATTEMPTS) {
    return { status: "exhausted", attempts: used, budget: TASK_ATTEMPTS };
  }
  return { status: "missing", attempts: used, budget: TASK_ATTEMPTS };
}

// The attempts of `task`, under any binding, whose run has no settled
// verdict: an armed or uncertain Land among them blocks every writer.
function unsettledAttempts(
  rows: readonly Row[],
  task: Binding["task"],
): Row<Attempt>[] {
  return rows
    .filter(isAttempt)
    .filter(
      (row) =>
        row.binding.task === task && determined(rows, row.run.id) === undefined,
    );
}

// The status of `binding` in the issue's records; a hold is a status, never
// absence.
function taskStatus(
  cfg: Pick<Config, "repo" | "mergeAccount">,
  number: number,
  comments: readonly IssueComment[],
  binding: Binding,
): TaskStatus {
  try {
    return statusIn(taskRecords(cfg, number, comments), binding);
  } catch (error) {
    if (error instanceof TaskResultsHold) {
      return { status: "held", reason: error.message };
    }
    throw error;
  }
}

export { checkedRows, statusIn, taskRecords, taskStatus, unsettledAttempts };
