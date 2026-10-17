// A stage job's status file, runs/<slug>/issue-N/job.json: what it shows
// while a session runs and once the job has finished.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import {
  messageEnd,
  outputEnd,
  TURN_OUTPUT,
  toolEnd,
  turns,
} from "./fake-rpc-pi.mjs";
import {
  PASS_VERDICT,
  piStarts,
  repliesAt,
  runJob,
  SWEEP_STAGE,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  USAGE,
  USAGE_TOTAL,
} from "./job-test-kit.mjs";
import { ISSUE } from "./workflow-stages-fixtures.mjs";

const STAGE_ARGS = ["--stage", SWEEP_STAGE, "--lane", "L"];
const SPEC_BUDGET = 80_000;
// The job a status file is opened for, less its stage.
const JOB = {
  id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  issue: ISSUE,
  lane: null,
  startedAt: "2026-10-17T12:00:00.000Z",
  socket: "/s",
};
const FIRST_CONTEXT = 50_000;
const LAST_CONTEXT = 51_000;
// An acceptance verifier's turn context past its 60k budget and under the
// hard limit.
const OVER_VERIFIER_BUDGET = 90_000;
const IMPLEMENTER_BUDGET = 150_000;

test("while a session waits, job.json shows its pid, session, last event and tool failures", async () => {
  const place = setUp(repliesAt(SWEEP_STAGE), {
    events: [toolEnd(true), toolEnd(true), "wait"],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(
    "two tool failures in job.json",
    () => sessionOf(statusOf(place))?.toolFailures === 2,
  );
  const status = statusOf(place);
  assert.equal(status.version, 1);
  assert.equal(status.pid, job.child.pid);
  assert.equal(status.issue, ISSUE);
  assert.equal(status.stage, SWEEP_STAGE);
  assert.equal(status.lane, "L");
  assert.equal(status.outcome, null);
  assert.ok(Date.parse(status.startedAt) > 0);
  const launch = sessionOf(status);
  const [start] = piStarts(place);
  assert.equal(launch.pid, start.pid);
  assert.equal(launch.session, start.argv[start.argv.indexOf("--session") + 1]);
  assert.ok(Date.parse(launch.lastEventAt) > 0);
  assert.equal(launch.outcome, null);
  assert.equal(launch.resumed, false);
  job.child.kill("SIGTERM");
  await job.end;
});

test("job.json counts consecutive failures of the same tool and keeps the last one's tool and error (#235)", async () => {
  const place = setUp(repliesAt(SWEEP_STAGE), {
    events: [
      toolEnd(true, "bash", "exit 1"),
      toolEnd(true, "read", "ENOENT: a.ts"),
      toolEnd(true, "read", "ENOENT: b.ts"),
      "wait",
    ],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(
    "the last tool failure in job.json",
    () => sessionOf(statusOf(place))?.lastToolFailure?.error === "ENOENT: b.ts",
  );
  const launch = sessionOf(statusOf(place));
  assert.equal(launch.toolFailures, 2);
  assert.deepEqual(launch.lastToolFailure, {
    tool: "read",
    error: "ENOENT: b.ts",
  });
  job.child.kill("SIGTERM");
  await job.end;
});

test("a finished job's file counts only the last tool failures and records each outcome", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), {
    events: [
      toolEnd(true),
      toolEnd(true),
      outputEnd(PASS_VERDICT),
      toolEnd(true),
      messageEnd(USAGE),
    ],
  });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const status = statusOf(place);
  assert.equal(status.outcome.kind, "finished");
  assert.ok(Date.parse(status.endedAt) > 0);
  const launch = sessionOf(status);
  assert.equal(launch.toolFailures, 1);
  assert.equal(launch.outcome, "ok");
  assert.deepEqual(launch.usage, USAGE);
  // The verifier is no writer session, so it has no watchdog max.
  assert.equal(launch.tokenBudget, null);
  assert.equal(launch.contextTokens, USAGE_TOTAL);
  const ops = status.launches.filter(
    (/** @type {{ kind: string }} */ { kind }) => kind === "ops",
  );
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.equal(op.session, null);
    assert.equal(op.outcome, "ok");
    assert.equal(op.tokenBudget, null);
  }
  assert.deepEqual(fs.readdirSync(place.runDir).sort(), [
    "context.jsonl",
    "job.json",
    "jobs.jsonl",
    "sessions",
  ]);
});

test("a non-writer session past its role's budget records no token budget, so the watchdog never stops it", () => {
  const events = [...turns([OVER_VERIFIER_BUDGET]), outputEnd(PASS_VERDICT)];
  const place = setUp(repliesAt(SWEEP_STAGE), { events });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const launch = sessionOf(statusOf(place));
  assert.equal(launch.outcome, "ok");
  assert.equal(launch.contextTokens, OVER_VERIFIER_BUDGET + TURN_OUTPUT);
  assert.equal(launch.tokenBudget, null);
});

test("a writer session records its token budget, which the watchdog stops it past", async () => {
  const place = setUp(repliesAt("implement"), { events: ["wait"] });
  const job = startJob(place, ["--stage", "implement"]);
  await waitFor(
    "the session's launch in job.json",
    () => sessionOf(statusOf(place)) !== null,
  );
  // The implementer's default budget at the default session cap.
  assert.equal(sessionOf(statusOf(place)).tokenBudget, IMPLEMENTER_BUDGET);
  job.child.kill("SIGTERM");
  await job.end;
});

test("job.json's lostChanges and droppedPatches round-trip through its schema", async () => {
  const { openStatus, socketOf } = await import("../src/job/status.ts");
  const runDir = fs.mkdtempSync("/tmp/issue-pipeline-status-");
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const job = { ...JOB, stage: "implement" };
  const status = openStatus(runDir, job);
  const patches = ["dropped/implement-1-repo.patch"];
  status.lostChanges(["repo/a.txt", "docs/B.md"], patches);
  const file = path.join(runDir, "job.json");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(written.lostChanges, ["repo/a.txt", "docs/B.md"]);
  assert.deepEqual(written.droppedPatches, patches);
  assert.equal(socketOf(runDir), "/s");
  const { droppedPatches: _, ...older } = written;
  fs.writeFileSync(file, JSON.stringify(older));
  assert.equal(socketOf(runDir), "/s");
  fs.writeFileSync(file, JSON.stringify({ ...written, lostChanges: "a.txt" }));
  assert.equal(socketOf(runDir), null);
});

/** @param {number} input @returns {import("../src/job/token-usage.ts").Usage} */
function usageOf(input) {
  return {
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cost: 0,
  };
}

test("a launch records its token budget, and its context is the latest message's total, not the sum (#281)", async () => {
  const { openStatus, readStatus } = await import("../src/job/status.ts");
  const runDir = fs.mkdtempSync("/tmp/issue-pipeline-status-");
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const job = { ...JOB, stage: "review" };
  const status = openStatus(runDir, job);
  const start = { pid: 1, session: "/s.jsonl", resumed: false };
  const key = "i1-review-1";
  const zero = usageOf(0);
  status.started({
    ...start,
    key,
    kind: "session",
    usage: zero,
    tokenBudget: SPEC_BUDGET,
  });
  assert.equal(readStatus(runDir)?.launches[0]?.contextTokens, 0);
  // Each turn re-reads the context, so the sum passes the budget long before
  // the context does.
  status.record(key, messageEnd(usageOf(FIRST_CONTEXT)));
  status.record(key, toolEnd(false, "read"));
  status.record(key, messageEnd(usageOf(LAST_CONTEXT)));
  const launch = readStatus(runDir)?.launches[0];
  assert.equal(launch?.tokenBudget, SPEC_BUDGET);
  assert.equal(launch?.contextTokens, LAST_CONTEXT);
  assert.equal(launch?.usage.input, FIRST_CONTEXT + LAST_CONTEXT);
});

test("an older job.json without a token budget or context size still parses, as null and 0 (#281)", async () => {
  const { readStatus } = await import("../src/job/status.ts");
  const runDir = fs.mkdtempSync("/tmp/issue-pipeline-status-");
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const launch = {
    key: "i1-spec-1",
    kind: "session",
    pid: 1,
    session: null,
    startedAt: "2026-10-15T10:00:00.000Z",
    lastEventAt: null,
    toolFailures: 0,
    usage: USAGE,
    resumed: false,
    outcome: null,
  };
  const old = {
    version: 1,
    pid: 1,
    issue: ISSUE,
    stage: "spec",
    lane: null,
    startedAt: "2026-10-15T10:00:00.000Z",
    socket: "/s",
    outcome: null,
    launches: [launch],
  };
  fs.writeFileSync(path.join(runDir, "job.json"), JSON.stringify(old));
  const parsed = readStatus(runDir)?.launches[0];
  assert.equal(parsed?.tokenBudget, null);
  assert.equal(parsed?.contextTokens, 0);
});
