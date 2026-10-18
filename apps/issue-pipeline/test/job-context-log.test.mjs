// The issue's context log, runs/<slug>/issue-N/context.jsonl (Axlog,
// 2026-10-16): as each session ends the stage job appends one line of
// numbers and names, which outlives job.json: the session file, the job's
// id, its steers, cost and 1h cache writes, and the checkout's head. A
// session the job's stop (SIGTERM, as the watchdog sends) ended is logged as
// killed, and one with no launch record as unrecorded. Each async test has a
// timeout so a session the job never stops fails the test instead of hanging
// at the fake pi's "wait".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contextLogOf } from "../src/job/context-log.ts";
import { openStatus } from "../src/job/status.ts";
import { ZERO_USAGE } from "../src/job/token-usage.ts";
import { waitFor } from "./bounded-test-kit.mjs";
import { outputEnd, TURN_OUTPUT, turns } from "./fake-rpc-pi.mjs";
import { implementReplies } from "./implementor-job-test-kit.mjs";
import {
  CLEAN_REVIEW,
  flagValue,
  piStarts,
  repliesAt,
  runJob,
  SWEEP_STAGE,
  sessionOf,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.mjs";
import { ISSUE } from "./workflow-stages-fixtures.mjs";

const HANG_GUARD = { timeout: 60_000 };
const LIMITS = { contextLimits: { soft: 1000, hard: 2000 } };
// Turn contexts: the first, the peak and the last, and one past hard.
const FIRST = 600;
const PEAK = 1800;
const LAST = 1200;
const PAST_SOFT = 1200;
const PAST_HARD = 2100;
// The job id the orchestrator would pass.
const JOB_ID = "0b6f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
// A job that starts at fix and moves on to checks.
const MOVING_JOB = {
  id: JOB_ID,
  issue: ISSUE,
  stage: "fix",
  lane: null,
  startedAt: "2026-10-17T12:00:00.000Z",
  socket: "/s",
};
// What `turns` spends over FIRST, PEAK and LAST: a quarter of each context
// as input and as cache writes, the rest as cache reads, and TURN_OUTPUT
// output tokens a turn.
const SPENT = {
  input: 900,
  output: 15_000,
  cacheRead: 1800,
  cacheWrite: 900,
  cacheWrite1h: 0,
  cost: 0,
};
const TURNS = 3;
// A line's fields, in order.
const LINE_FIELDS = [
  "at",
  "issue",
  "stage",
  "key",
  "session",
  "resumed",
  "job",
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
  "steers",
  "headSha",
  "reviewedSha",
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

test("an ended session's line holds its file, job, role, stage, model, end, context measures, usage, steers and the head it reviewed, and no text", () => {
  const events = [...turns([FIRST, PEAK, LAST]), outputEnd(CLEAN_REVIEW)];
  const place = setUp(repliesAt(SWEEP_STAGE), { events }, LIMITS);
  const r = runJob(place, ["--stage", SWEEP_STAGE, "--job-id", JOB_ID]);
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
      session: path.basename(launch.session),
      resumed: false,
      job: JOB_ID,
      role: "reviewer",
      agent: "issue-pipeline-reader",
      model: flagValue(start.argv, "--model"),
      ended: "ok",
      peakContext: PEAK,
      contextTokens: LAST + TURN_OUTPUT,
      firstContext: FIRST,
      turns: TURNS,
      usage: SPENT,
      contextStop: null,
      steers: { context: 0, socket: 0 },
      headSha: start.head,
      reviewedSha: start.head,
    },
  );
  const text = fs.readFileSync(
    path.join(place.runDir, "context.jsonl"),
    "utf8",
  );
  assert.ok(!text.includes("security reviewer"), text);
});

test(
  "a writer steered at soft and stopped at hard is logged as a handoff with its steer and stop, and names no reviewed head",
  HANG_GUARD,
  async () => {
    const events = [
      ...turns([PAST_SOFT]),
      "wait",
      ...turns([PAST_HARD]),
      "wait",
    ];
    // No continuations, so the first handoff stops the issue.
    const once = { ...LIMITS, maxContinuations: 0 };
    const place = setUp(implementReplies(), { events }, once);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const [line, ...more] = contextLines(place);
    assert.deepEqual(more, []);
    assert.equal(line.role, "implementer");
    assert.equal(line.agent, "issue-pipeline-writer");
    assert.equal(line.ended, "handoff");
    assert.deepEqual(line.contextStop, { context: PAST_HARD });
    assert.equal(line.peakContext, PAST_HARD);
    assert.deepEqual(line.steers, { context: 1, socket: 0 });
    assert.equal(line.headSha, piStarts(place)[0].head);
    assert.equal(line.reviewedSha, null);
    assert.equal(typeof line.job, "string");
  },
);

test(
  "a session the job's stop ends, as on the watchdog's SIGTERM, is logged as killed",
  HANG_GUARD,
  async () => {
    const events = [...turns([FIRST]), "wait"];
    const place = setUp(repliesAt(SWEEP_STAGE), { events }, LIMITS);
    const job = startJob(place, ["--stage", SWEEP_STAGE]);
    await waitFor(
      "the session's first turn in job.json",
      () => sessionOf(statusOf(place))?.turns === 1,
    );
    job.child.kill("SIGTERM");
    await job.end;
    const [line, ...more] = contextLines(place);
    assert.deepEqual(more, []);
    assert.equal(line.key, sessionOf(statusOf(place)).key);
    assert.equal(line.ended, "killed");
    assert.equal(line.role, "reviewer");
    assert.equal(line.turns, 1);
    assert.equal(line.firstContext, FIRST);
    assert.equal(line.peakContext, FIRST);
  },
);

const STEERS = { context: 0, socket: 0 };

/**
 * The line a reviewer session that ended ok is logged with, through the
 * job's `status`, made in a fresh run folder by `statusIn`.
 * @param {(runDir: string) => Pick<import("../src/job/status.ts").JobStatus, "launch" | "currentStage">} statusIn
 * @returns {any}
 */
function loggedLine(statusIn) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-log-"));
  const watch = { status: statusIn(runDir), control: { stopping: () => null } };
  const log = contextLogOf(runDir, { issue: ISSUE, id: JOB_ID }, watch);
  log("i7-review-2", {
    budgetRole: "reviewer",
    agent: "issue-pipeline-reader",
    model: "anthropic/claude-opus-5-5",
    ended: "ok",
    steers: STEERS,
    headSha: "abc1234",
    reviewedSha: "abc1234",
  });
  const lines = fs.readFileSync(path.join(runDir, "context.jsonl"), "utf8");
  const [line] = lines.split("\n").map((text) => text && JSON.parse(text));
  fs.rmSync(runDir, { recursive: true, force: true });
  return line;
}

test("a session with no launch record is logged as unrecorded, with no file or measures", () => {
  const line = loggedLine(() => ({
    launch: () => null,
    currentStage: () => "review",
  }));
  assert.deepEqual(Object.keys(line), LINE_FIELDS);
  assert.deepEqual(
    { ...line, at: null },
    {
      at: null,
      issue: ISSUE,
      stage: "review",
      key: "i7-review-2",
      session: null,
      resumed: null,
      job: JOB_ID,
      role: "reviewer",
      agent: "issue-pipeline-reader",
      model: "anthropic/claude-opus-5-5",
      ended: "unrecorded",
      peakContext: 0,
      contextTokens: 0,
      firstContext: null,
      turns: 0,
      usage: ZERO_USAGE,
      contextStop: null,
      steers: STEERS,
      headSha: "abc1234",
      reviewedSha: "abc1234",
    },
  );
});

test("a session that ends once the job moved on is logged at the stage it moved to (#424)", () => {
  const line = loggedLine((runDir) => {
    const status = openStatus(runDir, MOVING_JOB);
    status.moved("checks");
    return status;
  });
  assert.equal(line.stage, "checks");
});
