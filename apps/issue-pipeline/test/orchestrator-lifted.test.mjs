// @ts-check
// A lifted issue (#381): its stop label is gone but its state is still saved
// at `stopped`, with a stopped stage a restart resumes at. The orchestrator
// runs it at that stage under the usual caps, file holds and merge order, as
// "Restart after a stop" promises, logging a `lifted` line with the stop's
// code, then `started` with reason `lifted`; its job's claim turns the state
// back. A stop label, a stage no restart
// resumes or answered questions still get no decision.
import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import {
  CAPPED,
  issue,
  NOW,
  SETTINGS,
  snapshotOf,
} from "./orchestrator-fixtures.mjs";
import { withoutJobId } from "./orchestrator-job-id-kit.mjs";
import {
  CONFIG,
  cfg,
  configWith,
  openWith,
  runFile,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { schedule } = await import("../src/orchestrator/schedule.ts");
const { tick } = await import("../src/orchestrator/tick.ts");

/** @import { Config } from "../src/config.ts" */
/** @import { ScheduleSettings, Snapshot, SnapshotIssue } from "../src/orchestrator/queue.ts" */
/** @import { IssueFields } from "./orchestrator-fixtures.mjs" */

const REVIEW_JOB = { live: true, stage: "review" };

// An issue saved at `stopped` after a stop in `stoppedStage`, its stop label
// gone, then `fields`.
/** @param {string} stoppedStage @param {IssueFields & { number: number }} fields @returns {SnapshotIssue} */
function lifted(stoppedStage, fields) {
  return issue({ stage: "stopped", stoppedStage, ...fields });
}

// Each decision as `#issue stage action reason`, and a merge's queue.
/** @param {Snapshot} snapshot @param {ScheduleSettings} [settings] @returns {string[]} */
function decided(snapshot, settings = SETTINGS) {
  return schedule(snapshot, settings, NOW).map((decision) => {
    const { issue: number, stage, action, reason } = decision;
    let queue = "";
    if (decision.action === "started" && decision.mergeQueue !== null) {
      queue = ` queue:${decision.mergeQueue.map((n) => `#${n}`).join(",")}`;
    }
    return `#${number} ${stage} ${action} ${reason}${queue}`;
  });
}

test("a lifted issue starts at its stopped stage with reason lifted", () => {
  const snapshot = snapshotOf([lifted("checks", { number: 1, pr: 5 })]);
  assert.deepEqual(schedule(snapshot, SETTINGS, NOW), [
    {
      action: "started",
      at: NOW.toISOString(),
      issue: 1,
      stage: "checks",
      reason: "lifted",
      mergeQueue: null,
      stackOn: null,
    },
  ]);
});

test("a lifted issue is held at the global cap like any other start", () => {
  const snapshot = snapshotOf([
    lifted("checks", { number: 1, pr: 5, changed: ["a.ts"] }),
    issue({ number: 2, stage: "review", job: REVIEW_JOB, changed: ["b.ts"] }),
    issue({ number: 3, stage: "review", job: REVIEW_JOB, changed: ["c.ts"] }),
  ]);
  assert.deepEqual(decided(snapshot, CAPPED), ["#1 checks held global-cap"]);
});

test("a lifted checks isn't held by an older live branch ranked ahead of it that changes its stub", () => {
  const snapshot = snapshotOf([
    issue({ number: 1, stage: "sync", pr: 4, changed: ["src/a.ts"] }),
    lifted("checks", {
      number: 2,
      pr: 5,
      stubs: ["src/a.ts"],
      changed: ["src/a.ts"],
    }),
  ]);
  assert.deepEqual(decided(snapshot), [
    "#2 checks started lifted",
    "#1 sync started free",
  ]);
});

test("a lifted issue past implement holds a younger implement whose stub its branch changes", () => {
  const snapshot = snapshotOf([
    lifted("fix", { number: 1, pr: 5, changed: ["src/b.ts"] }),
    issue({ number: 2, stage: "implement", stubs: ["src/b.ts"] }),
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 fix started lifted",
    "#2 implement held files-overlap:#1",
  ]);
});

test("a lifted merge ranked first starts with the merge queue", () => {
  const snapshot = snapshotOf([
    lifted("merge", { number: 1, pr: 5, changed: ["a.ts"] }),
    issue({ number: 2, stage: "checks", pr: 6, changed: ["b.ts"] }),
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 merge started lifted queue:#1,#2",
    "#2 checks started free",
  ]);
});

test("a lifted merge waits for a higher-ranked issue at accept", () => {
  const snapshot = snapshotOf([
    lifted("merge", { number: 1, pr: 41, changed: ["a.ts"] }),
    issue({ number: 2, stage: "accept", pr: 40, changed: ["b.ts"] }),
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 merge held merge-order:#2",
    "#2 accept started free",
  ]);
});

test("a lifted issue at accept holds the merges ranked after it", () => {
  const snapshot = snapshotOf([
    issue({ number: 1, stage: "merge", pr: 41, changed: ["a.ts"] }),
    lifted("accept", { number: 2, pr: 40, changed: ["b.ts"] }),
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 merge held merge-order:#2",
    "#2 accept started lifted",
  ]);
});

test("an issue lifted after a stop at publish starts publish", () => {
  const snapshot = snapshotOf([lifted("publish", { number: 1, pr: 5 })]);
  assert.deepEqual(decided(snapshot), ["#1 publish started lifted"]);
});

test("a stop label, a stopped stage no restart resumes, or answered questions get no decision", () => {
  const snapshot = snapshotOf([
    lifted("checks", { number: 1, stopped: true, verdict: { kind: "skip" } }),
    lifted("done", { number: 2 }),
    lifted("checks", {
      number: 3,
      verdict: { kind: "candidate", answered: true },
    }),
    issue({ number: 4, stage: "stopped" }),
  ]);
  assert.deepEqual(decided(snapshot), []);
});

const LOG_LINE = z.object({
  issue: z.number(),
  stage: z.string(),
  action: z.string(),
  reason: z.string(),
});
const ISSUE = { checks: 100, merge: 101, labelled: 102, paused: 103 };
const STOPPED_AT_CHECKS = {
  stage: "stopped",
  stoppedStage: "checks",
  stopCode: "check-fixes",
  pr: 5,
};

// The watchdog, steer and escalation agent, which no test here is due.
const UNWATCHED = {
  runAgent: () => {
    throw new Error("unexpected escalation agent run");
  },
  steer: () => {
    throw new Error("unexpected steer");
  },
  terminate: () => {
    throw new Error("unexpected SIGTERM");
  },
};

// One tick of `config` (the base one by default), with the argv of each job
// it spawned, less its job id, and its log lines for `number`.
/** @param {number} number @param {Config} [config] */
function tickFor(number, config = cfg) {
  /** @type {(readonly string[])[]} */
  const spawned = [];
  const { decisions } = tick(config, {
    configPath: CONFIG,
    now: () => NOW,
    spawn: (argv) => {
      spawned.push(withoutJobId(argv));
      return process.pid;
    },
    ...UNWATCHED,
  });
  return { decisions, spawned, logged: logLinesOf(number) };
}

// The stage, action and reason of each line orchestrator.log holds for
// issue #number.
/** @param {number} number @returns {{ stage: string, action: string, reason: string }[]} */
function logLinesOf(number) {
  const log = runFile("orchestrator.log");
  if (!fs.existsSync(log)) {
    return [];
  }
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => LOG_LINE.parse(JSON.parse(line)))
    .filter((line) => line.issue === number)
    .map(({ stage, action, reason }) => ({ stage, action, reason }));
}

/** @param {number} number @param {string} stage @returns {string[]} */
function argvOf(number, stage) {
  return [
    "--config",
    CONFIG,
    "--issue",
    String(number),
    "--stage",
    stage,
    "--lane",
    "orchestrator",
  ];
}

test("a tick spawns a lifted issue's job at its stopped stage, without --resume, and logs it lifted with its stop's code, then started", () => {
  openWith([{ number: ISSUE.checks, state: STOPPED_AT_CHECKS }]);
  const { spawned, logged } = tickFor(ISSUE.checks);
  assert.deepEqual(spawned, [argvOf(ISSUE.checks, "checks")]);
  assert.deepEqual(logged, [
    { stage: "checks", action: "lifted", reason: STOPPED_AT_CHECKS.stopCode },
    { stage: "checks", action: "started", reason: "lifted" },
  ]);
});

test("a tick spawns a lifted merge with its merge queue, logging a stop with no code as stopped", () => {
  const state = { stage: "stopped", stoppedStage: "merge", pr: 6 };
  openWith([{ number: ISSUE.merge, state }]);
  const { spawned, logged } = tickFor(ISSUE.merge);
  const queue = ["--merge-queue", String(ISSUE.merge)];
  assert.deepEqual(spawned, [[...argvOf(ISSUE.merge, "merge"), ...queue]]);
  assert.deepEqual(logged, [
    { stage: "merge", action: "lifted", reason: "stopped" },
    { stage: "merge", action: "started", reason: "lifted" },
  ]);
});

test("a tick neither spawns nor logs an issue that still has its stop label", () => {
  openWith([
    {
      number: ISSUE.labelled,
      labels: ["agent:stopped-job"],
      state: STOPPED_AT_CHECKS,
    },
  ]);
  const { decisions, spawned, logged } = tickFor(ISSUE.labelled);
  assert.deepEqual(decisions, []);
  assert.deepEqual(spawned, []);
  assert.deepEqual(logged, []);
});

test("under takeNewWork false a lifted issue with no pipeline label waits, as lanes skip it", () => {
  const paused = loadConfig(configWith({ takeNewWork: false }));
  openWith([{ number: ISSUE.paused, state: STOPPED_AT_CHECKS }]);
  const { decisions, spawned, logged } = tickFor(ISSUE.paused, paused);
  assert.deepEqual(decisions, []);
  assert.deepEqual(spawned, []);
  assert.deepEqual(logged, []);
});
