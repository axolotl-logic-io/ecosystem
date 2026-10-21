// @ts-check
// The caller's launcher, scripts/caller-jobs.ts: `start` checks the run's
// exclusions, attempts and caps, the live jobs and the issue's state before
// it runs job.mjs detached with a receipt; `status` and `wait` read the
// receipts and each job's job.json. caller-jobs-test-kit.mjs's fake job and
// fake gh stand in for the stage job and GitHub, so no model, network or
// installed pipeline is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { alive, endsWithTest, waitFor } from "./bounded-test-kit.mjs";
import {
  CONFIG,
  FOURTH_ISSUE,
  gh,
  hasStarted,
  hasStatusFile,
  ISSUE,
  issuesOnGitHub,
  launcher,
  launcherArgv,
  linesOf,
  MODEL_ENV,
  modelFileReads,
  newRun,
  receiptsOf,
  refusal,
  release,
  runFolder,
  SECOND_ISSUE,
  SLUG,
  seenBy,
  setLimits,
  start,
  THIRD_ISSUE,
} from "./caller-jobs-test-kit.mjs";

// The launcher's exit for a refused start.
const REFUSED = 2;
const WAIT_SECONDS = "20";

test("start runs job.mjs detached with a receipt, and status shows its result once", async () => {
  issuesOnGitHub();
  const run = newRun({});
  const out = start(run, ISSUE, "implement", ["--merge-queue", "7,8"]);
  assert.equal(out.code, 0, out.stderr);
  const [launch] = out.lines;
  assert.equal(launch.attempt, 1);
  assert.equal(
    launch.receipt,
    path.join(run, "jobs", SLUG, "issue-7", "implement-1"),
  );
  assert.ok(alive(launch.pid), "the job outlives the launcher");
  await waitFor("the fake job's start", () => hasStarted(ISSUE));
  const seen = seenBy(ISSUE);
  assert.deepEqual(seen.argv, [
    "--config",
    CONFIG,
    "--issue",
    "7",
    "--branch",
    "issue-7",
    "--lane",
    "L",
    "--stage",
    "implement",
    "--job-id",
    launch.jobId,
    "--merge-queue",
    "7,8",
  ]);
  assert.equal(seen.ghToken, null, "the job gets no outer GitHub token");
  const [running] = launcher(["status", "--run", run]).lines;
  assert.equal(running.running, true);
  assert.equal(running.result, null);

  release(ISSUE, "next");
  await waitFor("the fake job's end", () => !alive(launch.pid));
  const [ended] = launcher(["status", "--run", run]).lines;
  assert.equal(ended.running, false);
  assert.equal(ended.newlyEnded, true);
  assert.deepEqual(ended.result, {
    issue: ISSUE,
    stage: "implement",
    end: "next",
  });
  assert.deepEqual(ended.outcome, { kind: "finished", end: "next" });
  assert.equal(ended.stderrTail, null);
  assert.ok(fs.existsSync(path.join(launch.receipt, "job.json")));
  const [again] = launcher(["status", "--run", run]).lines;
  assert.equal(again.newlyEnded, false);
});

test("only the job loads the run's modelEnvFile; the launcher never opens it", async () => {
  issuesOnGitHub();
  const run = newRun({ modelEnvFile: MODEL_ENV });
  const out = start(run, ISSUE, "author");
  assert.equal(out.code, 0, out.stderr);
  await waitFor("the fake job's start", () => hasStarted(ISSUE));
  assert.equal(seenBy(ISSUE).modelKey, "fake-model-key");
  release(ISSUE, "stop");
  const [launch] = out.lines;
  await waitFor("the fake job's end", () => !alive(launch.pid));
  const shown = JSON.stringify(launcher(["status", "--run", run]).lines);
  assert.deepEqual(modelFileReads(), []);
  const kept = fs
    .readdirSync(launch.receipt)
    .map((file) => fs.readFileSync(path.join(launch.receipt, file), "utf8"));
  for (const text of [JSON.stringify(out.lines), shown, ...kept]) {
    assert.ok(!text.includes(MODEL_ENV), "nothing names the file");
    assert.ok(!text.includes("fake-model-key"), "nothing holds its value");
  }
});

test("start refuses a modelEnvFile that isn't a file, before it starts a job", () => {
  issuesOnGitHub();
  const run = newRun({ modelEnvFile: path.dirname(MODEL_ENV) });
  const out = start(run, ISSUE, "author");
  assert.equal(out.code, 1);
  assert.equal(
    out.stderr,
    `caller-jobs: modelEnvFile ${path.dirname(MODEL_ENV)} is not a file\n`,
  );
  assert.deepEqual(receiptsOf(run), []);
});

test("wait returns when a job ends, and shows why one failed without a result", async () => {
  issuesOnGitHub();
  const run = newRun({});
  assert.equal(start(run, ISSUE, "review").code, 0);
  const waiting = spawn(
    process.execPath,
    launcherArgv(["wait", "--run", run, "--seconds", WAIT_SECONDS]),
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  endsWithTest(() => waiting.kill("SIGKILL"));
  let stdout = "";
  waiting.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const exited = new Promise((done) => {
    // "close" comes once its stdout has been read; "exit" may come before.
    waiting.on("close", done);
  });
  await waitFor("the fake job's start", () => hasStarted(ISSUE));
  release(ISSUE, "crash");
  assert.equal(await exited, 0);
  const [waited, failed] = linesOf(stdout);
  assert.deepEqual(waited, { waited: "ended" });
  assert.equal(failed.running, false);
  assert.equal(failed.result, null);
  assert.equal(failed.stderrTail, "fake job failed\n");
  const [idle] = launcher(["wait", "--run", run, "--seconds", "1"]).lines;
  assert.deepEqual(idle, { waited: "idle" });
});

test("start refuses an excluded issue without asking GitHub or starting a job", () => {
  issuesOnGitHub();
  const run = newRun({ excludedIssues: { "o/r": [ISSUE] } });
  const out = start(run, ISSUE, "author");
  assert.equal(out.code, REFUSED);
  assert.equal(refusal(out), "#7 is excluded this run");
  assert.deepEqual(gh.calls(), []);
  assert.deepEqual(receiptsOf(run), []);
});

test("start refuses an issue GitHub shows closed", () => {
  issuesOnGitHub([SECOND_ISSUE]);
  const run = newRun({});
  const out = start(run, SECOND_ISSUE, "author");
  assert.equal(out.code, REFUSED);
  assert.equal(refusal(out), "GitHub shows #8 as closed");
  assert.deepEqual(receiptsOf(run), []);
});

test("start refuses a second live job on an issue, and jobs past the caps", async () => {
  issuesOnGitHub();
  const run = newRun({ maxJobs: 2, maxStageJobs: { review: 1 } });
  assert.equal(start(run, ISSUE, "review").code, 0);
  const again = start(run, ISSUE, "implement");
  assert.equal(refusal(again), "#7 already has a live job");
  assert.equal(
    refusal(start(run, SECOND_ISSUE, "review")),
    "1 review jobs are live; the cap is 1",
  );
  assert.equal(start(run, SECOND_ISSUE, "implement").code, 0);
  const full = start(run, THIRD_ISSUE, "author");
  assert.equal(full.code, REFUSED);
  assert.equal(refusal(full), "2 jobs are live; the cap is 2");
  release(ISSUE, "stop");
  release(SECOND_ISSUE, "stop");
  await waitFor("both jobs' ends", () =>
    launcher(["status", "--run", run]).lines.every((job) => !job.running),
  );
  assert.equal(start(run, THIRD_ISSUE, "author").code, 0);
  release(THIRD_ISSUE, "stop");
});

test("start counts a live job another caller started, and one merge per repo", async () => {
  issuesOnGitHub();
  const elsewhere = newRun({});
  assert.equal(start(elsewhere, THIRD_ISSUE, "merge").code, 0);
  await waitFor("the other job's job.json", () => hasStatusFile(THIRD_ISSUE));
  const run = runFolder({ maxJobs: 1 });
  assert.equal(
    refusal(start(run, FOURTH_ISSUE, "author")),
    "1 jobs are live; the cap is 1",
  );
  setLimits(run, {});
  assert.equal(
    refusal(start(run, THIRD_ISSUE, "review")),
    "#9 already has a live job",
  );
  assert.equal(
    refusal(start(run, FOURTH_ISSUE, "merge")),
    "o/r already has a live merge job",
  );
  assert.deepEqual(receiptsOf(run), []);
  release(THIRD_ISSUE, "stop");
});

test("start refuses a stage that has used its attempts", async () => {
  issuesOnGitHub();
  const run = newRun({ maxAttempts: 1 });
  const first = start(run, ISSUE, "implement");
  assert.equal(first.code, 0);
  release(ISSUE, "wait");
  await waitFor("the job's end", () => !alive(first.lines[0].pid));
  const second = start(run, ISSUE, "implement");
  assert.equal(second.code, REFUSED);
  assert.equal(refusal(second), "#7 implement has used its 1 attempts");
});
