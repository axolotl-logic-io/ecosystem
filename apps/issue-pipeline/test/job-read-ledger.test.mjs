// @ts-check
// The read ledger a stage job appends to a writer session's handoff
// (src/job/read-ledger.ts, appendReadLedger in src/job/stop-handoff.ts): the
// files the session opened with `read`, once each in first-read order, with
// their line ranges merged, from the reads that ended without an error. It
// is appended after any text already in the handoff, both when the job
// stopped the writer at the hard limit and when the writer replied
// `handoff`. Each async test has a timeout so a session the job never stops
// fails the test instead of hanging at the fake pi's "wait".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readLedger, readLedgerText } from "../src/job/read-ledger.ts";
import { appendReadLedger } from "../src/job/stop-handoff.ts";
import { outputEnd, turns } from "./fake-rpc-pi.mjs";
import { implementReplies } from "./implementor-job-test-kit.mjs";
import { repliesAt, setScript, setUp, startJob } from "./job-test-kit.mjs";

const KEY = "i7-spec-1";
const HANG_GUARD = { timeout: 60_000 };
const LIMITS = { contextLimits: { soft: 1000, hard: 2000 } };
const PAST_HARD = 2100;
const UNDER_SOFT = 600;
const ONCE = { ...LIMITS, maxContinuations: 0 };
const LEDGER_HEADING = "## Files session";
const OWN = "## Done\nThe parser; its tests are left.\n";

/**
 * A `read` call's start and end, failed when `isError`.
 * @param {string} id @param {Record<string, unknown>} args
 * @param {boolean} [isError]
 * @returns {object[]}
 */
function readCall(id, args, isError = false) {
  return [
    { type: "tool_execution_start", toolCallId: id, toolName: "read", args },
    {
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "read",
      result: { content: [] },
      isError,
    },
  ];
}

// The reads the job's tests play: a.ts in two touching ranges and one
// apart, b.ts whole, a failed read of gone.ts, and a bash call.
const READS = [
  ...readCall("r1", { path: "repo/src/a.ts", offset: 10, limit: 20 }),
  ...readCall("r2", { path: "repo/src/b.ts" }),
  ...readCall("r3", { path: "repo/src/a.ts", offset: 30, limit: 5 }),
  ...readCall("r4", { path: "repo/src/gone.ts" }, true),
  ...readCall("r5", { path: "repo/src/a.ts", offset: 100 }),
  {
    type: "tool_execution_start",
    toolCallId: "b1",
    toolName: "bash",
    args: { command: "cat repo/src/c.ts" },
  },
];
const LEDGER_LINES = [
  "- `repo/src/a.ts`: 10-34, 100-",
  "- `repo/src/b.ts`: 1-",
];

/** @param {readonly unknown[]} records */
function readsOf(records) {
  const ledger = readLedger();
  for (const record of records) {
    ledger.record(record);
  }
  return ledger.reads();
}

/** @param {string} file @returns {string} */
function same(file) {
  return file;
}

test("the ledger keeps the reads that ended without an error, in order", () => {
  const unended = readCall("r6", { path: "repo/src/d.ts" }).slice(0, 1);
  assert.deepEqual(readsOf([...READS, ...unended]), [
    { file: "repo/src/a.ts", start: 10, end: 29 },
    { file: "repo/src/b.ts", start: 1, end: null },
    { file: "repo/src/a.ts", start: 30, end: 34 },
    { file: "repo/src/a.ts", start: 100, end: null },
  ]);
});

test("the ledger's text lists each file once with its ranges merged, or is null with no reads", () => {
  const text = readLedgerText(KEY, readsOf(READS), same) ?? "";
  assert.ok(text.startsWith(`${LEDGER_HEADING} ${KEY} read`), text);
  assert.deepEqual(
    text.split("\n").filter((line) => line.startsWith("- ")),
    LEDGER_LINES,
  );
  const overlapping = [
    { file: "x.ts", start: 5, end: 9 },
    { file: "x.ts", start: 1, end: 6 },
    { file: "x.ts", start: 12, end: 12 },
    { file: "x.ts", start: 8, end: null },
  ];
  const all = readLedgerText(KEY, overlapping, same) ?? "";
  assert.ok(all.includes("- `x.ts`: 1-\n"), all);
  const apart = readLedgerText(KEY, overlapping.slice(0, -1), same) ?? "";
  assert.ok(apart.includes("- `x.ts`: 1-9, 12\n"), apart);
  assert.equal(readLedgerText(KEY, [], same), null);
});

test("appending the ledger keeps the handoff's text, names files from the session's folder, and skips a missing handoff", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "read-ledger-"));
  const file = path.join(dir, "handoff.md");
  const outside = path.join(os.tmpdir(), "elsewhere.ts");
  const reads = [
    { file: "@repo/a.ts", start: 1, end: 3 },
    { file: path.join(dir, "repo", "b.ts"), start: 2, end: 2 },
    { file: outside, start: 1, end: null },
  ];
  appendReadLedger(file, KEY, reads, dir);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, OWN);
  appendReadLedger(file, KEY, reads, dir);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(`${OWN}\n${LEDGER_HEADING}`), text);
  assert.ok(text.includes("- `repo/a.ts`: 1-3\n- `repo/b.ts`: 2\n"), text);
  assert.ok(text.includes(`- \`${outside}\`: 1-`), text);
  appendReadLedger(file, KEY, [], dir);
  assert.equal(fs.readFileSync(file, "utf8"), text);
});

/** @param {import("./job-test-kit.mjs").Place} place @returns {string} */
function handoffOf(place) {
  return fs.readFileSync(path.join(place.runDir, "handoff.md"), "utf8");
}

/** @param {string} handoff @returns {string[] | null} its ledger's lines */
function ledgerOf(handoff) {
  const at = handoff.indexOf(LEDGER_HEADING);
  if (at <= 0) {
    return null;
  }
  const lines = handoff.slice(at).split("\n");
  return lines.filter((line) => line.startsWith("- "));
}

test(
  "a writer the job stopped at hard gets its read ledger after the job's handoff",
  HANG_GUARD,
  async () => {
    const events = [...READS, ...turns([PAST_HARD]), "wait"];
    const place = setUp(implementReplies(), { events }, ONCE);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const handoff = handoffOf(place);
    assert.ok(handoff.startsWith("# Handoff:"), handoff);
    assert.deepEqual(ledgerOf(handoff), LEDGER_LINES, handoff);
  },
);

test(
  "a spec writer that replies handoff gets its read ledger after its own handoff",
  HANG_GUARD,
  async () => {
    const reply = { status: "handoff", summary: "Out of room." };
    const events = [...READS, ...turns([UNDER_SOFT]), outputEnd(reply)];
    const place = setUp(repliesAt("spec"), { events }, ONCE);
    const file = path.join(place.runDir, "handoff.md");
    setScript(place, { events, handoff: { file, text: OWN } });
    const end = await startJob(place, ["--stage", "spec"]).end;
    assert.equal(end.status, 0, end.stderr);
    const handoff = handoffOf(place);
    assert.ok(handoff.startsWith(OWN), handoff);
    assert.deepEqual(ledgerOf(handoff), LEDGER_LINES, handoff);
  },
);
