// The stage job holds each writer session to the config's contextLimits
// (#271): a writer whose turn context passes `soft` is steered once to hand
// off, and past `hard` is stopped after one session and hands off. Any other
// session is neither steered nor stopped (Axlog, 2026-10-16). job.json
// records each session's peak turn context and a writer's stop, and a
// context-stopped session is never resumed. Each async test has a timeout so
// a session the job never stops fails the test instead of hanging at the
// fake pi's "wait".
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { contextStopped } from "../src/job/context-watch.ts";
import { readStatus, resumePoints } from "../src/job/status.ts";
import { FIX_SCHEMA } from "../src/workflow/review-schemas.ts";
import { CIFIX_SCHEMA, IMPL_SCHEMA } from "../src/workflow/schemas.ts";
import { implReplyOf } from "../src/workflow/stages/build-replies.ts";
import { fixOf } from "../src/workflow/stages/checks-reply.ts";
import { fixReplyOf } from "../src/workflow/stages/review-replies.ts";
import { outputEnd, turns } from "./fake-rpc-pi.mjs";
import {
  logOf,
  PASS_VERDICT,
  piCommands,
  piStarts,
  repliesAt,
  SWEEP_STAGE,
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
    assert.deepEqual(launch.contextStop, { context: PAST_HARD });
    assert.equal(launch.outcome, "ok");
    // Out of room with no continuations left: the sweep took the handoff.
    const stop = logOf(place, "ops.log").find(({ op }) => op === "stop");
    const request = JSON.stringify(stop);
    assert.ok(request.includes(String(PAST_HARD)), request);
  },
);

test(
  "a reader past soft and hard is neither steered nor stopped, and finishes",
  HANG_GUARD,
  async () => {
    const events = [
      ...turns([STILL_PAST_SOFT, PAST_HARD]),
      outputEnd(PASS_VERDICT),
    ];
    const place = setUp(repliesAt(SWEEP_STAGE), { events }, LIMITS);
    const end = await startJob(place, ["--stage", SWEEP_STAGE]).end;
    assert.equal(end.status, 0, end.stderr);
    assert.deepEqual(commandsOf(place, "abort"), []);
    assert.deepEqual(commandsOf(place, "steer"), []);
    assert.equal(piStarts(place).length, 1);
    const launch = sessionOf(statusOf(place));
    assert.equal(launch.contextStop, null);
    assert.equal(launch.outcome, "ok");
    assert.equal(launch.peakContext, PAST_HARD);
  },
);

test(
  "a writer past hard hands off after exactly one session",
  HANG_GUARD,
  async () => {
    const events = [...turns([PAST_HARD]), "wait"];
    const place = setUp(IMPLEMENT_ONCE, { events }, LIMITS);
    const end = await startJob(place, ["--stage", "implement"]).end;
    assert.equal(end.status, 0, end.stderr);
    assert.equal(piStarts(place).length, 1);
    const sessions = sessionsOf(statusOf(place));
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0].contextStop, { context: PAST_HARD });
  },
);

test("--resume never resumes a context-stopped session, and reads an older file's stop and retry", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-pipeline-run-"));
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const startedAt = new Date().toISOString();
  /** @param {string} key @param {object | null} contextStop */
  function interrupted(key, contextStop) {
    const session = path.join(runDir, `${key}.jsonl`);
    fs.writeFileSync(session, "{}\n");
    return {
      key,
      kind: "session",
      pid: null,
      session,
      startedAt,
      lastEventAt: null,
      toolFailures: 0,
      usage: USAGE,
      contextStop,
      resumed: false,
      outcome: null,
    };
  }
  // An older job's reader stop carried a result and a .retry launch.
  const launches = [
    interrupted("i7-implement-1", { context: PAST_HARD }),
    interrupted("i7-spec-1", { context: PAST_HARD, result: "error" }),
    interrupted("i7-spec-1.retry", null),
  ];
  const status = {
    version: 1,
    pid: 1,
    issue: ISSUE,
    stage: "spec",
    lane: null,
    startedAt,
    socket: path.join(runDir, "job.sock"),
    outcome: null,
    launches,
  };
  fs.writeFileSync(path.join(runDir, "job.json"), JSON.stringify(status));
  const pointOf = resumePoints(runDir);
  assert.equal(pointOf("i7-implement-1"), null);
  assert.equal(pointOf("i7-spec-1"), null);
  const read = readStatus(runDir)?.launches ?? [];
  assert.equal(read.length, launches.length);
  assert.deepEqual(read[1]?.contextStop, { context: PAST_HARD });
});

test(
  "a session under soft runs as before and records its peak",
  HANG_GUARD,
  async () => {
    const events = [...turns([LOW, LOW_PEAK]), outputEnd(PASS_VERDICT)];
    const place = setUp(repliesAt(SWEEP_STAGE), { events }, LIMITS);
    const end = await startJob(place, ["--stage", SWEEP_STAGE]).end;
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
  const stop = { context: PAST_HARD };
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
