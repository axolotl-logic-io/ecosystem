// The landing account's appends to a work item's v2 task records
// (src/tasks/records.ts). Each append reads the records fresh, checks that
// the new record keeps them consistent as the next reader will check them,
// posts it, and reads them back to confirm exactly that record. A read
// that can't confirm it leaves the record uncertain: the next caller
// reconciles by reading and never repeats the append.

import { listComments, rawComment } from "../comments.ts";
import type { Config } from "../config.ts";
import type { Receipt, Verdict } from "../domain.ts";
import { MAX_SUMMARY } from "../domain.ts";
import { redactGhArgs } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { redactLocalPaths } from "../pipeline-root.ts";
import { redactAddresses } from "../redact-addresses.ts";
import type { Attempt, Records, Row, TaskRecord } from "../tasks/records.ts";
import {
  RecordsHold,
  readRecords,
  recordBody,
  withProposed,
} from "../tasks/records.ts";

// Above every comment id GitHub has given, so a proposed record sorts last.
const PROPOSED_ID: number = Number.MAX_SAFE_INTEGER;

// Compare the public summary we actually send, not its private diagnostic
// preimage. No authority field may change at the transport boundary.
function publicRecord(record: TaskRecord): TaskRecord {
  let expected = record;
  if (record.kind === "result") {
    expected = {
      ...record,
      receipt: {
        ...record.receipt,
        summary: redactAddresses(
          redactLocalPaths(record.receipt.summary),
        ).slice(0, MAX_SUMMARY),
      },
    };
  }
  const field = `body=${recordBody(expected)}`;
  if (redactGhArgs([field])[0] !== field) {
    throw new OpsError(
      "task record would change outside its public summary during redaction",
    );
  }
  return expected;
}

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
  const expected = publicRecord(record);
  const body = recordBody(expected);
  const mine = records.rows.filter(
    (row) =>
      row.kind === expected.kind &&
      row.run.id === expected.run.id &&
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
  const expected = publicRecord(record);
  refusedIfHolds(before, expected);
  rawComment(cfg, number, recordBody(expected), true);
  return confirmedRecord(cfg, number, expected);
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
