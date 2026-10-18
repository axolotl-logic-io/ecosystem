// @ts-check
// The usage records of a stage that drives the sweep (src/job/driven-run.ts):
// each model session's record, with its launch key, its stage's role and
// pi's cost and 1h cache writes, then the job's record, which jobs.jsonl in
// the issue's run folder keeps too; every record carries the job id the
// orchestrator passed and the job's start, as job.json names them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseUsageLine } from "../src/job/usage-log.ts";
import {
  flagValue,
  logOf,
  piStarts,
  repliesAt,
  runJob,
  SWEEP_SESSION,
  SWEEP_STAGE,
  sessionOf,
  setUp,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

const JOB_ID = "0b6f7c1e-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const NOT_A_UUID = /--job-id must be a UUID/u;

/** @param {import("./job-test-kit.mjs").Place} place */
function usageRecords(place) {
  return logOf(place, "ops.log")
    .filter(({ op }) => op === "usage")
    .map(({ line }) => parseUsageLine(String(line)));
}

test("a driven stage's job appends a session record per session and a job record, each with the job's id and start", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), SWEEP_SESSION);
  const r = runJob(place, ["--stage", SWEEP_STAGE, "--job-id", JOB_ID]);
  assert.equal(r.status, 0, r.stderr);
  const status = statusOf(place);
  assert.equal(status.id, JOB_ID);
  const launch = sessionOf(status);
  const records = usageRecords(place);
  assert.deepEqual(
    records.map((record) => record?.kind),
    ["session", "job"],
  );
  const [session, job] = records;
  assert.equal(session?.kind, "session");
  assert.equal(job?.kind, "job");
  if (session?.kind !== "session" || job?.kind !== "job") {
    return;
  }
  const identity = {
    repo: session.repo,
    issue: 7,
    job: JOB_ID,
    jobStartedAt: status.startedAt,
  };
  assert.deepEqual(
    {
      repo: session.repo,
      issue: session.issue,
      job: session.job,
      jobStartedAt: session.jobStartedAt,
    },
    identity,
  );
  assert.equal(session.key, launch.key);
  assert.equal(session.role, "reviewer");
  assert.equal(session.stage, SWEEP_STAGE);
  assert.equal(session.state, session.name);
  assert.equal(session.attempt, 1);
  assert.equal(session.ended, "reply");
  assert.equal(session.model, flagValue(piStarts(place)[0].argv, "--model"));
  assert.deepEqual(session.tokens, USAGE);
  assert.equal(job.job, JOB_ID);
  assert.equal(job.jobStartedAt, status.startedAt);
  assert.equal(job.role, "reviewer");
  assert.deepEqual(job.tokens, USAGE);
  assert.equal(job.stages[0], SWEEP_STAGE);
  const release = logOf(place, "ops.log").find(({ op }) => op === "release");
  assert.ok(job.issueTokens > 0);
  assert.equal(job.issueTokens, release?.state.reportedTokens);
  const jobs = fs
    .readFileSync(path.join(place.runDir, "jobs.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(jobs, [job]);
});

test("a job started without --job-id makes its own and still runs", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), SWEEP_SESSION);
  const r = runJob(place, ["--stage", SWEEP_STAGE]);
  assert.equal(r.status, 0, r.stderr);
  const { id } = statusOf(place);
  assert.equal(typeof id, "string");
  assert.notEqual(id, JOB_ID);
  const records = usageRecords(place);
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.equal(record?.job, id);
  }
});

test("a --job-id that is no UUID is refused before anything starts", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), SWEEP_SESSION);
  const r = runJob(place, ["--stage", SWEEP_STAGE, "--job-id", "nope"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, NOT_A_UUID);
  assert.deepEqual(logOf(place, "ops.log"), []);
});
