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
import { resultProse } from "../tasks/result-prose.ts";

// Above every comment id GitHub has given, so a proposed record sorts last.
const PROPOSED_ID: number = Number.MAX_SAFE_INTEGER;

type Json = Exclude<Receipt["evidence"], undefined>;

function redacted(text: string): string {
  return redactAddresses(redactLocalPaths(text));
}

// `value` with every string in it redacted; keys, numbers and structure are
// kept.
function redactedJson(value: Json): Json {
  if (typeof value === "string") {
    return redacted(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactedJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactedJson(item)]),
    );
  }
  return value;
}

// The record as it may be posted: no local path or IP address anywhere in
// it. A result's receipt, its summary and every string of its evidence, is
// redacted. Every other field identifies the work and must already be
// clean; one that redaction would change refuses the record instead.
function publicRecord(record: TaskRecord): TaskRecord {
  let expected = record;
  if (record.kind === "result") {
    const receipt: Receipt = {
      ...record.receipt,
      summary: redacted(record.receipt.summary).slice(0, MAX_SUMMARY),
    };
    if (record.receipt.evidence !== undefined) {
      receipt.evidence = redactedJson(record.receipt.evidence);
    }
    expected = { ...record, receipt };
  }
  const field = `body=${recordBody(expected)}`;
  if (redactGhArgs([field])[0] !== field) {
    throw new OpsError(
      "task record names a local path or address outside its receipt",
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

// The prose a person reads under `record`: a result says what happened and
// what comes next; an attempt is bookkeeping and says nothing. Redacted as
// the transport would, so the posted words are the ones composed.
function proseOf(record: TaskRecord): string {
  if (record.kind !== "result") {
    return "";
  }
  return redacted(resultProse(record));
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
  rawComment(cfg, number, recordBody(expected, proseOf(expected)), true);
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

export { appendRecord, confirmedRecord, freshRecords, publicRecord, settleRun };
