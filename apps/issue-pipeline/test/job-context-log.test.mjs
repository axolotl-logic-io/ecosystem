// @ts-check
// The issue's context log, runs/<slug>/issue-N/context.jsonl (Axlog,
// 2026-10-16): as each session ends the stage job appends one line of
// numbers and names, which outlives job.json: the session file, the job's
// id, its steers, cost and 1h cache writes, and the checkout's head. A
// session the job's stop (SIGTERM, as the watchdog sends) ended is logged as
// killed, and one with no launch record as unrecorded. A session's context
// is recorded, never limited (`no-session-budgets`): the retired soft-limit
// steer and hard-limit handoff are replaced by an implementor session past
// both old limits logged as ending ok, with no steer. Each async test has a
// timeout so a session the job never stops fails the test instead of
// hanging at the fake pi's "wait".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";

const { contextLogOf } = await import("../src/job/context-log.ts");
const { openStatus } = await import("../src/job/status.ts");
const { ZERO_USAGE } = await import("../src/job/token-usage.ts");
const { waitFor } = await import("./bounded-test-kit.mjs");
const { outputEnd, TURN_OUTPUT, turns } = await import("./fake-rpc-pi.mjs");
const { AUTHORED, IMPLEMENTED, implementReplies, READER_STAGE, repliesAt } =
  await import("./job-fixtures.mjs");
const { flagValue, piStarts, runJob, sessionOf, setUp, startJob, statusOf } =
  await import("./job-test-kit.mjs");

// The issue job-fixtures.mjs claims.
const ISSUE = 7;
const HANG_GUARD = { timeout: 60_000 };
// Turn contexts: the first, the peak and the last.
const FIRST = 600;
const PEAK = 1800;
const LAST = 1200;
// Turn contexts past the retired soft and hard limits of 1000 and 2000.
const PAST_SOFT = 1200;
const PAST_HARD = 2100;
// The job id the orchestrator would pass.
const JOB_ID = "0b6f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
// A job that starts at implement and moves on to review.
const MOVING_JOB = {
  id: JOB_ID,
  issue: ISSUE,
  stage: "implement",
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

test("the root the job tests' modules read is the test's temporary one", () => {
  assert.equal(fs.statSync(isolatedRoot).isDirectory(), true);
});

test("an ended author session's line holds its file, job, role, stage, model, end, context measures, usage, steers and the head it read, and no text", () => {
  const events = [...turns([FIRST, PEAK, LAST]), outputEnd(AUTHORED)];
  const place = setUp(repliesAt(READER_STAGE), { events });
  const r = runJob(place, ["--stage", READER_STAGE, "--job-id", JOB_ID]);
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
      stage: READER_STAGE,
      key: "author-1",
      session: path.basename(launch.session),
      job: JOB_ID,
      role: "author",
      agent: "issue-pipeline-author",
      model: flagValue(start.argv, "--model"),
      ended: "ok",
      peakContext: PEAK,
      contextTokens: LAST + TURN_OUTPUT,
      firstContext: FIRST,
      turns: TURNS,
      usage: SPENT,
      steers: { socket: 0 },
      headSha: start.head,
      reviewedSha: start.head,
    },
  );
  const text = fs.readFileSync(
    path.join(place.runDir, "context.jsonl"),
    "utf8",
  );
  assert.ok(!text.includes(AUTHORED.gherkin), text);
});

test(
  "an implementor session past the retired soft and hard limits is never steered or handed off: it is logged as ending ok, naming no reviewed head",
  HANG_GUARD,
  async () => {
    const events = [...turns([PAST_SOFT, PAST_HARD]), outputEnd(IMPLEMENTED)];
    const place = setUp(implementReplies(), { events });
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    assert.equal(JSON.parse(end.stdout).end, "next");
    const [line, ...more] = contextLines(place);
    assert.deepEqual(more, []);
    assert.equal(line.key, "implementor-1");
    assert.equal(line.role, "implementor");
    assert.equal(line.agent, "issue-pipeline-implementor");
    assert.equal(line.ended, "ok");
    assert.equal(line.peakContext, PAST_HARD);
    assert.equal(line.contextTokens, PAST_HARD + TURN_OUTPUT);
    assert.deepEqual(line.steers, { socket: 0 });
    assert.equal(line.headSha, piStarts(place)[0].head);
    assert.equal(line.reviewedSha, null);
    assert.equal(line.stage, "implement");
    assert.equal(typeof line.job, "string");
  },
);

test(
  "a session the job's stop ends, as on the watchdog's SIGTERM, is logged as killed",
  HANG_GUARD,
  async () => {
    const events = [...turns([FIRST]), "wait"];
    const place = setUp(repliesAt(READER_STAGE), { events });
    const job = startJob(place, ["--stage", READER_STAGE]);
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
    assert.equal(line.role, "author");
    assert.equal(line.turns, 1);
    assert.equal(line.firstContext, FIRST);
    assert.equal(line.peakContext, FIRST);
  },
);

const STEERS = { socket: 0 };

/**
 * The line a reviewer session that ended ok is logged with, through the
 * job's `status`, made in a fresh run folder by `statusIn`.
 * @param {(runDir: string) => Pick<import("../src/job/status.ts").JobStatus, "launch" | "currentStage">} statusIn
 * @returns {any}
 */
function loggedLine(statusIn) {
  const runDir = fs.mkdtempSync(path.join(isolatedRoot, "context-log-"));
  const watch = { status: statusIn(runDir), control: { stopping: () => null } };
  const log = contextLogOf(runDir, { issue: ISSUE, id: JOB_ID }, watch);
  log("reviewer-2", {
    role: "reviewer",
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
      key: "reviewer-2",
      session: null,
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
      steers: STEERS,
      headSha: "abc1234",
      reviewedSha: "abc1234",
    },
  );
});

test("a session that ends once the job moved on is logged at the stage it moved to (#424)", () => {
  const line = loggedLine((runDir) => {
    const status = openStatus(runDir, MOVING_JOB);
    status.moved("review");
    return status;
  });
  assert.equal(line.stage, "review");
});
