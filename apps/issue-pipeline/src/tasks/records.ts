// Task attempt and result records, version 2 (docs/reference/task-results.md).
// Each attempt and each result is its own append-only hidden comment that
// only the landing account writes. A record names its canonical verb task,
// its binding, the action run (its id and the run it follows), the buddy run
// that produced it and the signal that caused it. Any other version, a
// malformed record or records that contradict each other hold the item.

import { z } from "zod";
import { assertCommentAuthority } from "../comment-authority.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import type { Binding, TaskId, TaskResult } from "../domain.ts";
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

const MARK = "<!-- agent-pipeline:task-result\n";
const END = "\n-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Each task's attempts per binding. At the limit the task stops for a
// person; a new binding starts a new budget.
const TASK_ATTEMPTS = 3;
const VERSION = 2;

const ATTEMPT = z.strictObject({
  version: z.literal(VERSION),
  kind: z.literal("attempt"),
  binding: BINDING,
  run: RUN_REF,
  buddyRun: UUID,
  cause: ACTION_CAUSE,
});
const RESULT = z.strictObject({
  version: z.literal(VERSION),
  kind: z.literal("result"),
  binding: BINDING,
  run: RUN_REF,
  buddyRun: UUID,
  cause: ACTION_CAUSE,
  verdict: VERDICT,
  receipt: RECEIPT,
});
const RECORD = z.discriminatedUnion("kind", [ATTEMPT, RESULT]);
const VERSIONED = z.looseObject({ version: z.unknown() });

type Attempt = z.infer<typeof ATTEMPT>;
type Result = z.infer<typeof RESULT>;
type TaskRecord = z.infer<typeof RECORD>;
type Row<T extends TaskRecord = TaskRecord> = T & { id: number };

interface Records {
  rows: readonly Row[];
}

type BindingStatus =
  | { status: "passed" | "refused"; result: Row<Result>; attempts: number }
  | { status: "failed"; result: Row<Result>; attempts: number }
  | { status: "unknown"; attempt: Row<Attempt>; attempts: number }
  | { status: "missing"; attempts: 0 };

// Records the reader can't trust as read: they hold the work item.
class RecordsHold extends OpsError {}

function hold(reason: string): never {
  throw new RecordsHold(`task records require reconciliation: ${reason}`);
}

function isAttempt(row: Row): row is Row<Attempt> {
  return row.kind === "attempt";
}

function isResult(row: Row): row is Row<Result> {
  return row.kind === "result";
}

function recordBody(record: TaskRecord): string {
  const json = JSON.stringify(RECORD.parse(record)).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  return `${MARK}${json}${END}`;
}

function rawRecord(comment: IssueComment, body: string): unknown {
  if (!body.endsWith(END)) {
    hold(`comment ${comment.id} is a malformed record`);
  }
  try {
    const raw: unknown = JSON.parse(body.slice(MARK.length, -END.length));
    return raw;
  } catch {
    return hold(`comment ${comment.id} is an unreadable record`);
  }
}

// The record `comment` holds, if any. A body that starts with the mark is a
// record claim: anyone but the landing account writing it holds.
function parsedComment(
  cfg: Pick<Config, "repo" | "landingAccount">,
  number: number,
  comment: IssueComment,
): Row | null {
  const body = comment.body ?? "";
  if (!body.startsWith(MARK)) {
    return null;
  }
  try {
    assertCommentAuthority(cfg, comment);
  } catch {
    hold(`comment ${comment.id} is not the landing account's own record`);
  }
  const raw = rawRecord(comment, body);
  const versioned = VERSIONED.safeParse(raw);
  const version = versioned.data?.version;
  if (version !== VERSION) {
    hold(`comment ${comment.id} has unknown record version ${String(version)}`);
  }
  const parsed = RECORD.safeParse(raw);
  if (!parsed.success) {
    hold(`comment ${comment.id} is an invalid version 2 record`);
  }
  const { workItem } = parsed.data.binding;
  if (
    workItem.repo.toLowerCase() !== cfg.repo.toLowerCase() ||
    workItem.number !== number
  ) {
    hold(`comment ${comment.id} is bound to another work item`);
  }
  return { ...parsed.data, id: comment.id };
}

// A run's determined verdict, if a result settled one.
function determined(
  rows: readonly Row[],
  run: string,
): Row<Result> | undefined {
  return rows
    .filter(isResult)
    .find((row) => row.run.id === run && row.verdict !== "unknown");
}

function checkFirstAttempt(earlier: readonly Row[], row: Row<Attempt>): void {
  const { previous } = row.run;
  if (
    previous !== null &&
    !earlier
      .filter(isAttempt)
      .some(
        (item) =>
          item.run.id === previous && item.binding.task === row.binding.task,
      )
  ) {
    hold(`run ${row.run.id} links to an unknown predecessor`);
  }
}

// A later attempt of a binding follows its latest attempt, only once that
// run settled failed, and only within the binding's budget.
function checkAttempt(rows: readonly Row[], row: Row<Attempt>): void {
  const earlier = rows.filter((item) => item.id < row.id);
  const same = earlier
    .filter(isAttempt)
    .filter((item) => sameBinding(item.binding, row.binding));
  const latest = same.at(-1);
  if (latest === undefined) {
    checkFirstAttempt(earlier, row);
    return;
  }
  if (row.run.previous !== latest.run.id) {
    hold(`run ${row.run.id} does not follow the binding's latest attempt`);
  }
  const settled = determined(earlier, latest.run.id);
  if (settled === undefined) {
    hold(`run ${row.run.id} repeated an unsettled attempt`);
  }
  if (settled.verdict !== "failed") {
    hold(`run ${row.run.id} reran a ${settled.verdict} binding`);
  }
  if (same.length >= TASK_ATTEMPTS) {
    hold(`run ${row.run.id} exceeds the binding's ${TASK_ATTEMPTS} attempts`);
  }
}

// A result names its own attempt exactly: binding, run, buddy run and cause.
// A run has at most one determined verdict, and no unknown after it.
function checkResult(rows: readonly Row[], row: Row<Result>): void {
  const earlier = rows.filter((item) => item.id < row.id);
  const attempt = earlier
    .filter(isAttempt)
    .find((item) => item.run.id === row.run.id);
  if (
    attempt === undefined ||
    !sameBinding(attempt.binding, row.binding) ||
    attempt.run.previous !== row.run.previous ||
    attempt.buddyRun !== row.buddyRun ||
    attempt.cause.signal !== row.cause.signal ||
    attempt.cause.recordId !== row.cause.recordId
  ) {
    hold(`result ${row.id} does not name its attempt exactly`);
  }
  if (determined(earlier, row.run.id) !== undefined) {
    hold(`run ${row.run.id} has a verdict after its settled one`);
  }
}

// `unordered` in comment order, once every rule holds across them.
function checkedRecords(unordered: readonly Row[]): Row[] {
  const rows = [...unordered].sort((a, b) => a.id - b.id);
  const ids = new Set<number>();
  const runs = new Set<string>();
  for (const row of rows) {
    if (ids.has(row.id)) {
      hold("duplicate record ids");
    }
    ids.add(row.id);
    if (isAttempt(row)) {
      if (runs.has(row.run.id)) {
        hold(`run ${row.run.id} reused its identity`);
      }
      runs.add(row.run.id);
      checkAttempt(rows, row);
    } else {
      checkResult(rows, row);
    }
  }
  return rows;
}

// The item's records, read from `comments` and checked; a record that can't
// be trusted as read throws RecordsHold.
function readRecords(
  cfg: Pick<Config, "repo" | "landingAccount">,
  number: number,
  comments: readonly IssueComment[],
): Records {
  const current = comments.flatMap(
    (comment) => parsedComment(cfg, number, comment) ?? [],
  );
  return { rows: checkedRecords(current) };
}

// `records` with `record` appended last, checked as the next reader checks
// them: a record that would make them hold is refused before it's written.
function withProposed(
  records: Records,
  record: TaskRecord,
  proposedId: number,
): Row[] {
  return checkedRecords([...records.rows, { ...record, id: proposedId }]);
}

function attemptsOf(rows: readonly Row[], binding: Binding): Row<Attempt>[] {
  return rows
    .filter(isAttempt)
    .filter((row) => sameBinding(row.binding, binding));
}

// One binding's status: its final pass or refusal, its latest failure, its
// unsettled run, or missing.
function statusOf(rows: readonly Row[], binding: Binding): BindingStatus {
  const attempts = attemptsOf(rows, binding);
  const used = attempts.length;
  const latest = attempts.at(-1);
  if (latest === undefined) {
    return { status: "missing", attempts: 0 };
  }
  const settled = determined(rows, latest.run.id);
  if (settled === undefined) {
    return { status: "unknown", attempt: latest, attempts: used };
  }
  if (settled.verdict === "passed" || settled.verdict === "refused") {
    return { status: settled.verdict, result: settled, attempts: used };
  }
  return { status: "failed", result: settled, attempts: used };
}

// The attempts of `task`, under any binding, whose run has no settled
// verdict.
function unsettled(rows: readonly Row[], task: TaskId): Row<Attempt>[] {
  return rows
    .filter(isAttempt)
    .filter(
      (row) =>
        row.binding.task === task && determined(rows, row.run.id) === undefined,
    );
}

// Every run as the domain's TaskResult, in record order: its determined
// verdict under its result comment's id, or, while it has none, verdict
// unknown under its attempt's id. An unknown result record settles nothing,
// so a run that ended uncertain and one interrupted before any result read
// alike.
function taskResults(rows: readonly Row[]): TaskResult[] {
  return rows
    .filter(isAttempt)
    .map((attempt): TaskResult => {
      const settled = determined(rows, attempt.run.id);
      if (settled === undefined) {
        return {
          binding: attempt.binding,
          run: attempt.run,
          buddyRun: attempt.buddyRun,
          cause: attempt.cause,
          verdict: "unknown",
          receipt: { summary: "the run has no settled verdict" },
          recordId: attempt.id,
        };
      }
      return {
        binding: settled.binding,
        run: settled.run,
        buddyRun: settled.buddyRun,
        cause: settled.cause,
        verdict: settled.verdict,
        receipt: settled.receipt,
        recordId: settled.id,
      };
    })
    .sort((a, b) => a.recordId - b.recordId);
}

export type { Attempt, BindingStatus, Records, Result, Row, TaskRecord };
export {
  attemptsOf,
  determined,
  isAttempt,
  isResult,
  RECORD,
  RecordsHold,
  readRecords,
  recordBody,
  statusOf,
  TASK_ATTEMPTS,
  taskResults,
  unsettled,
  withProposed,
};
