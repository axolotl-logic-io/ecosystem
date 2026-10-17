// The issue's context log, runs/<slug>/issue-N/context.jsonl (Axlog,
// 2026-10-16): as each session ends the stage job appends one line of
// numbers and names, which outlives job.json. A session the job's stop
// (SIGTERM, as the watchdog sends) ended is logged as killed. Each async test
// has a timeout so a session the job never stops fails the test instead of
// hanging at the fake pi's "wait".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { outputEnd, TURN_OUTPUT, turns } from "./fake-rpc-pi.mjs";
import {
  flagValue,
  PASS_VERDICT,
  piStarts,
  repliesAt,
  runJob,
  SWEEP_STAGE,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  waitFor,
} from "./job-test-kit.mjs";
import { ISSUE, sweepReply } from "./workflow-stages-fixtures.mjs";

const HANG_GUARD = { timeout: 60_000 };
const LIMITS = { contextLimits: { soft: 1000, hard: 2000 } };
// Turn contexts: the first, the peak and the last, and one past hard.
const FIRST = 600;
const PEAK = 1800;
const LAST = 1200;
const PAST_HARD = 2100;
// What `turns` spends over FIRST, PEAK and LAST: a quarter of each context
// as input and as cache writes, the rest as cache reads, and TURN_OUTPUT
// output tokens a turn.
const SPENT = { input: 900, output: 15_000, cacheRead: 1800, cacheWrite: 900 };
const TURNS = 3;
// A line's fields, in order.
const LINE_FIELDS = [
  "at",
  "issue",
  "stage",
  "key",
  "role",
  "agent",
  "model",
  "ended",
  "peakContext",
  "contextTokens",
  "firstContext",
  "turns",
  "usage",
  "contextStop",
];

/** @param {import("./job-test-kit.mjs").Place} place @returns {any[]} */
function contextLines(place) {
  const file = path.join(place.runDir, "context.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

test("an ended session's line holds its role, stage, model, end, context measures and usage, and no text", () => {
  const events = [...turns([FIRST, PEAK, LAST]), outputEnd(PASS_VERDICT)];
  const place = setUp(repliesAt(SWEEP_STAGE), { events }, LIMITS);
  const r = runJob(place, ["--stage", SWEEP_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const [line, ...more] = contextLines(place);
  assert.deepEqual(more, []);
  assert.deepEqual(Object.keys(line), LINE_FIELDS);
  const launch = sessionOf(statusOf(place));
  const [start] = piStarts(place);
  assert.ok(Date.parse(line.at) > 0);
  assert.deepEqual(
    { ...line, at: null },
    {
      at: null,
      issue: ISSUE,
      stage: SWEEP_STAGE,
      key: launch.key,
      role: "verifier",
      agent: "issue-pipeline-reader",
      model: flagValue(start.argv, "--model"),
      ended: "ok",
      peakContext: PEAK,
      contextTokens: LAST + TURN_OUTPUT,
      firstContext: FIRST,
      turns: TURNS,
      usage: SPENT,
      contextStop: null,
    },
  );
  const text = fs.readFileSync(
    path.join(place.runDir, "context.jsonl"),
    "utf8",
  );
  assert.ok(!text.includes(PASS_VERDICT.reason), text);
});

test(
  "a writer stopped at hard is logged as a handoff with its stop",
  HANG_GUARD,
  async () => {
    const replies = {
      ...repliesAt("implement"),
      sweep: sweepReply({ items: [ISSUE], config: { maxContinuations: 0 } }),
    };
    const events = [...turns([PAST_HARD]), "wait"];
    const place = setUp(replies, { events }, LIMITS);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const [line, ...more] = contextLines(place);
    assert.deepEqual(more, []);
    assert.equal(line.role, "implementer");
    assert.equal(line.agent, "issue-pipeline-writer");
    assert.equal(line.ended, "handoff");
    assert.deepEqual(line.contextStop, { context: PAST_HARD });
    assert.equal(line.peakContext, PAST_HARD);
  },
);

test(
  "a session the job's stop ends, as on the watchdog's SIGTERM, is logged as killed",
  HANG_GUARD,
  async () => {
    const events = [...turns([FIRST]), "wait"];
    const place = setUp(repliesAt(SWEEP_STAGE), { events }, LIMITS);
    const job = startJob(place, ["--stage", SWEEP_STAGE]);
    await waitFor(() => sessionOf(statusOf(place))?.turns === 1);
    job.child.kill("SIGTERM");
    await job.end;
    const [line, ...more] = contextLines(place);
    assert.deepEqual(more, []);
    assert.equal(line.key, sessionOf(statusOf(place)).key);
    assert.equal(line.ended, "killed");
    assert.equal(line.role, "verifier");
    assert.equal(line.turns, 1);
    assert.equal(line.firstContext, FIRST);
    assert.equal(line.peakContext, FIRST);
  },
);
