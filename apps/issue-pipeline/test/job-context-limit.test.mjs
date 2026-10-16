// The stage job holds every model session to the config's contextLimits
// (#271): a writer whose turn context passes `soft` is steered once to hand
// off, any session past `hard` is stopped, and job.json records each
// session's peak turn context and its stop. A stopped writer hands off; any
// other session fails. Each async test has a timeout so a session the job
// never stops fails the test instead of hanging at the fake pi's "wait".
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextStopped } from "../src/job/context-watch.ts";
import { FIX_SCHEMA } from "../src/workflow/review-schemas.ts";
import { CIFIX_SCHEMA, IMPL_SCHEMA } from "../src/workflow/schemas.ts";
import { implReplyOf } from "../src/workflow/stages/build-replies.ts";
import { fixOf } from "../src/workflow/stages/checks-reply.ts";
import { fixReplyOf } from "../src/workflow/stages/review-replies.ts";
import { outputEnd, turns } from "./fake-rpc-pi.mjs";
import {
  logOf,
  piCommands,
  READY_SPEC,
  repliesAt,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";
import { ISSUE, sweepReply } from "./workflow-stages-fixtures.mjs";

const SOFT = 1000;
const HARD = 2000;
const LIMITS = { contextLimits: { soft: SOFT, hard: HARD } };
// Turn contexts: below soft, past soft, and past hard.
const LOW = 600;
const LOW_PEAK = 900;
const PAST_SOFT = 1200;
const STILL_PAST_SOFT = 1500;
const PAST_HARD = 2100;
// A hang guard, not a timing dependency: without the context watch, the job
// never stops a session waiting at the fake pi's "wait".
const HANG_GUARD = { timeout: 60_000 };
const WRITER = "issue-pipeline-writer";
// Implement with no continuations, so the first handoff stops the issue.
const IMPLEMENT_ONCE = {
  ...repliesAt("implement"),
  sweep: sweepReply({ items: [ISSUE], config: { maxContinuations: 0 } }),
};

/** @param {import("./job-test-kit.mjs").Place} place @param {string} type */
function commandsOf(place, type) {
  return piCommands(place).filter((command) => command.type === type);
}

/** @param {any} status a job.json @returns {any[]} its session launches */
function sessionsOf(status) {
  return status.launches.filter(
    (/** @type {{ kind: string }} */ { kind }) => kind === "session",
  );
}

test(
  "a writer past soft is steered once, then stopped past hard as a handoff",
  HANG_GUARD,
  async () => {
    const events = [
      ...turns([LOW, PAST_SOFT]),
      "wait",
      ...turns([STILL_PAST_SOFT, PAST_HARD]),
      "wait",
    ];
    const place = setUp(IMPLEMENT_ONCE, { events }, LIMITS);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    const steers = commandsOf(place, "steer");
    assert.equal(steers.length, 1);
    assert.ok(steers[0].message.includes(String(PAST_SOFT)), steers[0].message);
    assert.ok(steers[0].message.includes("handoff"), steers[0].message);
    const types = piCommands(place).map(({ type }) => type);
    assert.ok(types.indexOf("abort") > types.indexOf("steer"));
    const launch = sessionOf(statusOf(place));
    assert.equal(launch.peakContext, PAST_HARD);
    const contextStop = { context: PAST_HARD, result: "handoff" };
    assert.deepEqual(launch.contextStop, contextStop);
    assert.equal(launch.outcome, "ok");
    // Out of room with no continuations left: the sweep took the handoff.
    const stop = logOf(place, "ops.log").find(({ op }) => op === "stop");
    const request = JSON.stringify(stop);
    assert.ok(request.includes(String(PAST_HARD)), request);
  },
);

test(
  "a reader past hard is stopped, never steered, and fails with an error",
  HANG_GUARD,
  async () => {
    const events = [...turns([STILL_PAST_SOFT, PAST_HARD]), "wait"];
    const place = setUp(repliesAt("spec"), { events }, LIMITS);
    const end = await startJob(place, ["--stage", "spec"]).end;
    assert.equal(end.status, 0, end.stderr);
    assert.notEqual(commandsOf(place, "abort").length, 0);
    assert.deepEqual(commandsOf(place, "steer"), []);
    const sessions = sessionsOf(statusOf(place));
    assert.notEqual(sessions.length, 0);
    const contextStop = { context: PAST_HARD, result: "error" };
    for (const launch of sessions) {
      assert.deepEqual(launch.contextStop, contextStop);
      assert.equal(launch.outcome, "failed");
      assert.equal(launch.peakContext, PAST_HARD);
    }
  },
);

test(
  "a session under soft runs as before and records its peak",
  HANG_GUARD,
  async () => {
    const events = [...turns([LOW, LOW_PEAK]), outputEnd(READY_SPEC)];
    const place = setUp(repliesAt("spec"), { events }, LIMITS);
    const end = await startJob(place, ["--stage", "spec"]).end;
    assert.equal(end.status, 0, end.stderr);
    assert.deepEqual(commandsOf(place, "steer"), []);
    assert.deepEqual(commandsOf(place, "abort"), []);
    const launch = sessionOf(statusOf(place));
    assert.equal(launch.peakContext, LOW_PEAK);
    assert.equal(launch.contextStop, null);
    assert.equal(launch.outcome, "ok");
  },
);

test("a writer stopped at hard hands off in every writer stage's reply", () => {
  /** @type {import("../src/job/context-watch.ts").ContextStop} */
  const stop = { context: PAST_HARD, result: "handoff" };
  /** @type {[import("../src/workflow/schemas.ts").JsonSchema, (output: unknown) => { status: string, summary: string } | null][]} */
  const stages = [
    [IMPL_SCHEMA, implReplyOf],
    [FIX_SCHEMA, fixReplyOf],
    [CIFIX_SCHEMA, fixOf],
  ];
  for (const [outputSchema, replyOf] of stages) {
    const launch = { key: "i7-implement-1", agent: WRITER, outputSchema };
    const raw = contextStopped(launch, stop, USAGE);
    assert.equal(raw.ok, true);
    assert.deepEqual(raw.results[0].usage, USAGE);
    const reply = replyOf(raw.structuredOutput);
    assert.equal(reply?.status, "handoff");
    assert.ok(reply.summary.includes(String(PAST_HARD)), reply.summary);
  }
});

test("a reader stopped at hard fails with an error naming its context", () => {
  const launch = {
    key: "i7-spec-1",
    agent: "issue-pipeline-specifier",
    outputSchema: IMPL_SCHEMA,
  };
  /** @type {import("../src/job/context-watch.ts").ContextStop} */
  const stop = { context: PAST_HARD, result: "error" };
  const raw = contextStopped(launch, stop, USAGE);
  assert.equal(raw.ok, false);
  assert.equal(raw.structuredOutput, null);
  assert.ok(raw.error?.includes(String(PAST_HARD)), String(raw.error));
  assert.deepEqual(raw.results[0].usage, USAGE);
});
