// A stage job's status file, runs/<slug>/issue-N/job.json: what it shows
// while a session runs and once the job has finished. A session's context
// figures are records, never limits (`no-session-budgets`): the retired
// per-role token budget and its watchdog stop are replaced by a session
// past any old budget running to its end with its context recorded.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import type { Usage } from "../../src/job/token-usage.ts";
import { waitFor } from "../bounded-test-kit.ts";
import {
  messageEnd,
  outputEnd,
  TURN_OUTPUT,
  toolEnd,
  turns,
} from "../fake-rpc-pi.ts";
import {
  AUTHORED,
  IMPLEMENTED,
  implementReplies,
  READER_STAGE,
  repliesAt,
  USAGE,
  USAGE_TOTAL,
} from "../job-fixtures.ts";
import {
  piStarts,
  runJob,
  sessionOf,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.ts";

const STAGE_ARGS: string[] = ["--stage", READER_STAGE, "--lane", "L"];
// The issue job-fixtures.ts claims.
const ISSUE = 7;
// A budget-era launch's token budget.
const OLD_BUDGET = 80_000;
// The job a status file is opened for, less its stage.
const JOB: {
  id: string;
  issue: number;
  lane: null;
  startedAt: string;
  socket: string;
  prompts: never[];
} = {
  id: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  issue: ISSUE,
  lane: null,
  startedAt: "2026-10-17T12:00:00.000Z",
  socket: "/s",
  prompts: [],
};
const FIRST_CONTEXT = 50_000;
const LAST_CONTEXT = 51_000;
// A turn's context past every retired session budget: the old reviewer's
// 60k and the implementer's 300k.
const PAST_OLD_BUDGETS = 400_000;

test("while a session waits, job.json shows its pid, session, last event and tool failures", async () => {
  const place = setUp(repliesAt(READER_STAGE), {
    events: [toolEnd(true), toolEnd(true), "wait"],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(
    "two tool failures in job.json",
    () => sessionOf(statusOf(place))?.toolFailures === 2,
  );
  const status = statusOf(place);
  assert.ok(status);
  assert.equal(status.version, 1);
  assert.equal(status.pipelineVersion, 2);
  assert.equal(status.pid, job.child.pid);
  assert.equal(status.issue, ISSUE);
  assert.equal(status.stage, READER_STAGE);
  assert.equal(status.lane, "L");
  assert.equal(status.outcome, null);
  assert.ok(Date.parse(status.startedAt) > 0);
  const launch = sessionOf(status);
  assert.ok(launch);
  const [start] = piStarts(place);
  assert.ok(start);
  assert.equal(launch.pid, start.pid);
  assert.equal(launch.session, start.argv[start.argv.indexOf("--session") + 1]);
  assert.ok(Date.parse(launch.lastEventAt ?? "") > 0);
  assert.equal(launch.outcome, null);
  assert.equal(launch.key, "author-1");
  job.child.kill("SIGTERM");
  await job.end;
});

test("job.json counts consecutive failures of the same tool and keeps the last one's tool and error (#235)", async () => {
  const place = setUp(repliesAt(READER_STAGE), {
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
  assert.ok(launch);
  assert.equal(launch.toolFailures, 2);
  assert.deepEqual(launch.lastToolFailure, {
    tool: "read",
    error: "ENOENT: b.ts",
  });
  job.child.kill("SIGTERM");
  await job.end;
});

test("a finished job's file counts only the last tool failures and records each outcome", () => {
  const place = setUp(repliesAt(READER_STAGE), {
    events: [
      toolEnd(true),
      toolEnd(true),
      outputEnd(AUTHORED),
      toolEnd(true),
      messageEnd(USAGE),
    ],
  });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const status = statusOf(place);
  assert.ok(status);
  assert.equal(status.outcome?.kind, "finished");
  assert.ok(Date.parse(status.endedAt ?? "") > 0);
  const launch = sessionOf(status);
  assert.ok(launch);
  assert.equal(launch.toolFailures, 1);
  assert.equal(launch.outcome, "ok");
  assert.deepEqual(launch.usage, USAGE);
  assert.equal("tokenBudget" in launch, false);
  assert.equal(launch.contextTokens, USAGE_TOTAL);
  const ops = status.launches.filter(({ kind }) => kind === "ops");
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.equal(op.session, null);
    assert.equal(op.outcome, "ok");
  }
  assert.deepEqual(fs.readdirSync(place.runDir).sort(), [
    "context.jsonl",
    "job.json",
    "jobs.jsonl",
    "sessions",
  ]);
});

test("an author session past every old session budget runs to its end with its context recorded", () => {
  const events = [...turns([PAST_OLD_BUDGETS]), outputEnd(AUTHORED)];
  const place = setUp(repliesAt(READER_STAGE), { events });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).end, "next");
  const launch = sessionOf(statusOf(place));
  assert.ok(launch);
  assert.equal(launch.outcome, "ok");
  assert.equal(launch.contextTokens, PAST_OLD_BUDGETS + TURN_OUTPUT);
  // The peak is what the model read that turn, less its output.
  assert.equal(launch.peakContext, PAST_OLD_BUDGETS);
  assert.equal("tokenBudget" in launch, false);
});

test("an implementor session past every old session budget is never stopped for it, and the job moves on to review", () => {
  const events = [...turns([PAST_OLD_BUDGETS]), outputEnd(IMPLEMENTED)];
  const place = setUp(implementReplies(), { events });
  const r = runJob(place, ["--stage", "implement"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    issue: ISSUE,
    stage: "implement",
    end: "next",
  });
  const status = statusOf(place);
  assert.ok(status);
  assert.equal(status.currentStage, "review");
  const launch = sessionOf(status);
  assert.ok(launch);
  assert.equal(launch.key, "implementor-1");
  assert.equal(launch.contextTokens, PAST_OLD_BUDGETS + TURN_OUTPUT);
  assert.equal("tokenBudget" in launch, false);
});

test("job.json's lostChanges and droppedPatches round-trip through its schema", async () => {
  const { openStatus, socketOf } = await import("../../src/job/status.ts");
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

function usageOf(input: number): Usage {
  return {
    input,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    cost: 0,
  };
}

test("a launch's context is the latest message's total, not the sum, and its peak, first context and turns are kept (#281)", async () => {
  const { openStatus, readStatus } = await import("../../src/job/status.ts");
  const runDir = fs.mkdtempSync("/tmp/issue-pipeline-status-");
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const status = openStatus(runDir, { ...JOB, stage: "review" });
  const key = "reviewer-1";
  status.started({ key, kind: "session", pid: 1, session: "/s.jsonl" });
  assert.equal(readStatus(runDir)?.launches[0]?.contextTokens, 0);
  // Each turn re-reads the context, so the sum is far past the context.
  status.record(key, messageEnd(usageOf(LAST_CONTEXT)));
  status.record(key, toolEnd(false, "read"));
  status.record(key, messageEnd(usageOf(FIRST_CONTEXT)));
  const launch = readStatus(runDir)?.launches[0];
  assert.equal(launch?.contextTokens, FIRST_CONTEXT);
  assert.equal(launch?.peakContext, LAST_CONTEXT);
  assert.equal(launch?.firstContext, LAST_CONTEXT);
  assert.equal(launch?.turns, 2);
  assert.equal(launch?.usage.input, FIRST_CONTEXT + LAST_CONTEXT);
});

test("an older job.json without context figures, a pipeline version or budget-era fields still parses, and isn't this pipeline's (#281)", async () => {
  const { isPipelineJob, readStatus } = await import("../../src/job/status.ts");
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
    tokenBudget: OLD_BUDGET,
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
  const read = readStatus(runDir);
  const parsed = read?.launches[0];
  assert.equal(parsed?.contextTokens, 0);
  assert.equal(parsed?.peakContext, 0);
  assert.equal(parsed?.firstContext, null);
  assert.equal(read && isPipelineJob(read), false);
});

test("job.json names the stage the job is at now: the stage it started at, then each stage it moved on to (#424)", async () => {
  const { currentStageOf, openStatus, readStatus } = await import(
    "../../src/job/status.ts"
  );
  const runDir = fs.mkdtempSync("/tmp/issue-pipeline-status-");
  process.on("exit", () => fs.rmSync(runDir, { recursive: true, force: true }));
  const status = openStatus(runDir, { ...JOB, stage: "author" });
  assert.equal(readStatus(runDir)?.currentStage, "author");
  status.moved("implement");
  const moved = readStatus(runDir);
  assert.equal(moved?.stage, "author");
  assert.equal(moved?.currentStage, "implement");
  assert.equal(moved && currentStageOf(moved), "implement");
  const { currentStage: _, ...older } = moved ?? {};
  fs.writeFileSync(path.join(runDir, "job.json"), JSON.stringify(older));
  const read = readStatus(runDir);
  assert.equal(read && currentStageOf(read), "author");
});
