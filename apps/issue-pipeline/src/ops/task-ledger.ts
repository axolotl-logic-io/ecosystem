// The landing account's appends to a work item's v2 task records
// (src/tasks/records.ts). Each append reads the records fresh, checks that
// the new record keeps them consistent as the next reader will check them,
// posts it, and reads them back to confirm exactly that record. A read
// that can't confirm it leaves the record uncertain: the next caller
// reconciles by reading and never repeats the append.

import { listComments, rawComment } from "../comments.ts";
import type { Config } from "../config.ts";
import type { Receipt, Verdict } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import type { Attempt, Records, Row, TaskRecord } from "../tasks/records.ts";
import {
  RecordsHold,
  readRecords,
  recordBody,
  withProposed,
} from "../tasks/records.ts";

// Above every comment id GitHub has given, so a proposed record sorts last.
const PROPOSED_ID: number = Number.MAX_SAFE_INTEGER;

function freshRecords(cfg: Config, number: number): Records {
  return readRecords(cfg, number, listComments(cfg, number));
}

// A record that would make the records hold is refused, with why.
function refusedIfHolds(records: Records, record: TaskRecord): void {
  try {
    withProposed(records, record, PROPOSED_ID);
  } catch (error) {
    if (error instanceof RecordsHold) {
      throw new OpsError(`refused: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

// The item's records read back, holding exactly `record` once.
function confirmedRecord(
  cfg: Config,
  number: number,
  record: TaskRecord,
): Records {
  let records: Records;
  try {
    records = freshRecords(cfg, number);
  } catch (error) {
    throw new OpsError(
      `the recorded ${record.kind} is uncertain; reconcile by reading before any retry`,
      { cause: error },
    );
  }
  const body = recordBody(record);
  const mine = records.rows.filter(
    (row) =>
      row.kind === record.kind &&
      row.run.id === record.run.id &&
      recordBody(withoutId(row)) === body,
  );
  if (mine.length !== 1) {
    throw new OpsError(
      `the recorded ${record.kind} is not readable; reconcile by reading before any retry`,
    );
  }
  return records;
}

function withoutId(row: Row): TaskRecord {
  const { id: _id, ...record } = row;
  return record;
}

// Appends `record` to the item's records `before`, read fresh by the
// caller, and returns the records read back with it.
function appendRecord(
  cfg: Config,
  number: number,
  before: Records,
  record: TaskRecord,
): Records {
  refusedIfHolds(before, record);
  rawComment(cfg, number, recordBody(record), true);
  return confirmedRecord(cfg, number, record);
}

// Settles `attempt`'s own run, the original one, with `verdict`: its
// binding, run, buddy run and cause as the attempt recorded them.
function settleRun(
  cfg: Config,
  number: number,
  before: Records,
  outcome: { attempt: Row<Attempt>; verdict: Verdict; receipt: Receipt },
): Records {
  const { attempt } = outcome;
  return appendRecord(cfg, number, before, {
    version: 2,
    kind: "result",
    binding: attempt.binding,
    run: attempt.run,
    buddyRun: attempt.buddyRun,
    cause: attempt.cause,
    verdict: outcome.verdict,
    receipt: outcome.receipt,
  });
}

export { appendRecord, confirmedRecord, freshRecords, settleRun };
