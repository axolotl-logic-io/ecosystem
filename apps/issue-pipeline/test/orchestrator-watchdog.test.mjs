// @ts-check
// The orchestrator's watchdog (#235), run through whole ticks over recorded
// job.json files: a dead job is restarted with --resume (a stage that runs
// a role, such as triage, without it, #304) up to maxResumes times per issue
// and stage and its issue then stopped with
// agent:stopped-job; finished, failed and stopped jobs and stopped issues are
// left alone; a silent session is steered at silentMinutes, and its job sent
// SIGTERM after as long again, then resumed once it has stopped. Each rule
// fires at its threshold and not before, and every action is logged: a
// restart with its job's pid and id, an escalation with the attempt its
// stage is at and the issue's tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { effectNames, effectsOf } from "./gh-effects.mjs";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  CONFIG,
  cfg,
  deadPid,
  fakeGh,
  MINUTE_MS,
  NOW,
  OTHERS_PID,
  runFile,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { ghIsRead } = await import("../src/github.ts");

/** @import { StatusFile } from "../src/job/status.ts" */

const ISSUE = {
  dead: 60,
  capped: 61,
  finished: 62,
  failed: 63,
  stoppedJob: 64,
  labelled: 65,
  silent: 66,
  quiet: 67,
  ops: 68,
  restarted: 69,
  deadTriage: 70,
  escalatedAfterRestart: 71,
};
const ISSUE_TOKENS = 4321;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;
const PR_OF_CAPPED = 9;
// The defaults, which the kit's config leaves to the watchdog.
const SILENT_MINUTES = 30;
// Far past every threshold: ops print nothing until they end.
const OPS_SILENT_MINUTES = 120;
const SILENT_STEER = "You have been silent; report status and carry on.";
// A job stopped by SIGTERM, as job.json records it.
/** @type {StatusFile["outcome"]} */
const STOPPED = { kind: "stopped", signal: "SIGTERM" };
/** @type {StatusFile["outcome"]} */
const FAILED = { kind: "failed", error: "boom" };

// Records that issue `issue`'s session was heard from `minutes` after NOW.
/** @param {number} issue @param {number} minutes @returns {void} */
function heardAt(issue, minutes) {
  const file = path.join(paths.runDir(cfg, issue), "job.json");
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  const at = new Date(NOW.getTime() + minutes * MINUTE_MS).toISOString();
  status.launches[0].lastEventAt = at;
  fs.writeFileSync(file, JSON.stringify(status));
}

// Every line orchestrator.log holds for `issue`, as written.
/** @param {number} issue @returns {any[]} */
function linesFor(issue) {
  return fs
    .readFileSync(runFile("orchestrator.log"), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .filter((line) => line.issue === issue);
}

/** @param {number} issue @param {string} stage @returns {string[]} */
function resumeArgv(issue, stage) {
  return [
    "--config",
    CONFIG,
    "--issue",
    String(issue),
    "--stage",
    stage,
    "--lane",
    "orchestrator",
    "--resume",
  ];
}

test("a dead job is restarted as the same stage with --resume, and the scheduler starts nothing else for it", () => {
  writeJob({ issue: ISSUE.dead, stage: "fix", pid: deadPid() });
  const { spawned } = tickOver([
    { number: ISSUE.dead, state: { stage: "fix" } },
  ]);
  assert.deepEqual(spawned, [resumeArgv(ISSUE.dead, "fix")]);
  assert.deepEqual(loggedFor(ISSUE.dead), [
    {
      issue: ISSUE.dead,
      stage: "fix",
      action: "resumed",
      reason: "dead",
    },
  ]);
});

test("a dead triage job is restarted without --resume, since its role restarts from its state", () => {
  writeJob({ issue: ISSUE.deadTriage, stage: "triage", pid: deadPid() });
  const { spawned } = tickOver([
    { number: ISSUE.deadTriage, state: { stage: "triage" } },
  ]);
  const [argv, ...more] = spawned;
  assert.deepEqual(more, []);
  const stageAt = argv?.indexOf("--stage") ?? -1;
  assert.equal(argv?.[stageAt + 1], "triage");
  assert.equal(argv?.includes("--resume"), false);
  assert.deepEqual(
    loggedFor(ISSUE.deadTriage).map(
      ({ action, reason }) => `${action} ${reason}`,
    ),
    ["resumed dead"],
  );
});

test("a restarted job still running from its start record is not restarted again while its old job.json is dead", () => {
  writeJob({ issue: ISSUE.restarted, stage: "fix", pid: deadPid() });
  const issues = [{ number: ISSUE.restarted, state: { stage: "fix" } }];
  const running = { spawnPid: OTHERS_PID };
  assert.deepEqual(tickOver(issues, 0, running).spawned, [
    resumeArgv(ISSUE.restarted, "fix"),
  ]);
  assert.deepEqual(tickOver(issues, 1, running).spawned, []);
  assert.deepEqual(
    loggedFor(ISSUE.restarted).map(
      ({ action, reason }) => `${action} ${reason}`,
    ),
    ["resumed dead"],
  );
});

test("after maxResumes restarts of a stage a dead job stops its issue and PR with agent:stopped-job", () => {
  writeJob({ issue: ISSUE.capped, stage: "review", pid: deadPid() });
  const issues = [
    { number: ISSUE.capped, state: { stage: "review", pr: PR_OF_CAPPED } },
  ];
  assert.equal(tickOver(issues).spawned.length, 1);
  assert.equal(tickOver(issues).spawned.length, 1);
  const third = tickOver(issues);
  assert.deepEqual(third.spawned, []);
  const names = effectNames(effectsOf(fakeGh.writes(ghIsRead)));
  assert.ok(names.includes(`label #${ISSUE.capped} agent:stopped-job`));
  assert.ok(names.includes(`label #${PR_OF_CAPPED} agent:stopped-job`));
  assert.deepEqual(
    loggedFor(ISSUE.capped).map(({ action, reason }) => `${action} ${reason}`),
    ["resumed dead", "resumed dead", "stopped max-resumes"],
  );
});

test("finished, failed and stopped jobs, and jobs of issues with a stop label, are never restarted", () => {
  const gone = deadPid();
  writeJob({ issue: ISSUE.finished, stage: "spec", pid: gone, ended: true });
  writeJob({ issue: ISSUE.failed, stage: "spec", pid: gone, outcome: FAILED });
  writeJob({
    issue: ISSUE.stoppedJob,
    stage: "fix",
    pid: gone,
    outcome: STOPPED,
  });
  writeJob({ issue: ISSUE.labelled, stage: "fix", pid: gone });
  const { spawned } = tickOver([
    { number: ISSUE.finished, state: { stage: "spec" } },
    { number: ISSUE.failed, state: { stage: "spec" } },
    { number: ISSUE.stoppedJob, state: { stage: "fix" } },
    {
      number: ISSUE.labelled,
      labels: ["agent:stopped-error"],
      state: { stage: "stopped" },
    },
  ]);
  assert.ok(spawned.every((argv) => !argv.includes("--resume")));
  for (const issue of [ISSUE.finished, ISSUE.failed, ISSUE.stoppedJob]) {
    assert.ok(loggedFor(issue).every(({ action }) => action !== "resumed"));
  }
  // The stop label is escalated, and nothing else is done for it.
  assert.deepEqual(
    loggedFor(ISSUE.labelled).map(({ action }) => action),
    ["escalated"],
  );
});

test("a session silent for silentMinutes is steered once, its job gets SIGTERM after as long again, and is resumed once stopped", () => {
  const job = { issue: ISSUE.silent, stage: "fix", pid: OTHERS_PID };
  writeJob({ ...job, silentMinutes: SILENT_MINUTES - 1 });
  const issues = [{ number: ISSUE.silent, state: { stage: "fix" } }];
  const early = tickOver(issues);
  assert.deepEqual([early.steered, early.terminated], [[], []]);
  const status = writeJob({ ...job, silentMinutes: SILENT_MINUTES });
  const key = `i${ISSUE.silent}-fix-1`;
  assert.deepEqual(tickOver(issues).steered, [
    [status.socket, key, SILENT_STEER],
  ]);
  const waiting = tickOver(issues, SILENT_MINUTES - 1);
  assert.deepEqual([waiting.steered, waiting.terminated], [[], []]);
  const due = tickOver(issues, SILENT_MINUTES);
  assert.deepEqual([due.steered, due.terminated], [[], [OTHERS_PID]]);
  assert.deepEqual(tickOver(issues, SILENT_MINUTES + 1).terminated, []);
  writeJob({
    ...job,
    pid: deadPid(),
    silentMinutes: SILENT_MINUTES,
    outcome: STOPPED,
  });
  const resumed = tickOver(issues, SILENT_MINUTES + 2);
  assert.deepEqual(resumed.spawned, [resumeArgv(ISSUE.silent, "fix")]);
  assert.deepEqual(
    loggedFor(ISSUE.silent).map(({ action, reason }) => `${action} ${reason}`),
    [`steered silent:${key}`, `killed silent:${key}`, "resumed dead"],
  );
});

test("a session heard from after its steer is not stopped, and ops launches are never steered", () => {
  const quiet = { issue: ISSUE.quiet, stage: "spec", pid: OTHERS_PID };
  writeJob({ ...quiet, silentMinutes: SILENT_MINUTES });
  const ops = { issue: ISSUE.ops, stage: "sync", pid: OTHERS_PID };
  writeJob({ ...ops, kind: "ops", silentMinutes: OPS_SILENT_MINUTES });
  const issues = [
    { number: ISSUE.quiet, state: { stage: "spec" } },
    { number: ISSUE.ops, state: { stage: "sync" } },
  ];
  assert.equal(tickOver(issues).steered.length, 1);
  heardAt(ISSUE.quiet, 1);
  const later = tickOver(issues, SILENT_MINUTES);
  assert.deepEqual([later.steered, later.terminated], [[], []]);
  assert.deepEqual(loggedFor(ISSUE.ops), []);
});

test("a restart's line names its job's pid and id, and a later stop's escalation the attempt its stopped stage is at and the issue's tokens", () => {
  const issue = ISSUE.escalatedAfterRestart;
  writeJob({ issue, stage: "review", pid: deadPid() });
  const { spawned } = tickOver([
    { number: issue, state: { stage: "review", reportedTokens: ISSUE_TOKENS } },
  ]);
  assert.equal(spawned.length, 1);
  const state = {
    stage: "stopped",
    stoppedStage: "review",
    reportedTokens: ISSUE_TOKENS,
  };
  tickOver([{ number: issue, labels: ["agent:stopped-error"], state }]);
  const [resumed, escalated, ...more] = linesFor(issue);
  assert.deepEqual(more, []);
  assert.equal(resumed.action, "resumed");
  assert.equal(typeof resumed.pid, "number");
  assert.match(resumed.job, UUID);
  assert.equal(escalated.action, "escalated");
  assert.equal(escalated.attempt, 2);
  assert.equal(escalated.issueTokens, ISSUE_TOKENS);
});
