// @ts-check
// The watchdog's budget rule (#281), run through whole ticks over recorded
// job.json files: a live job whose session's context (`contextTokens`) passes
// its token budget gets SIGTERM once, and once it has exited its issue and PR
// are stopped with agent:stopped-budget and it is never restarted. A launch at
// its budget, one with no budget, an ops launch, a launch that ended, a
// session stopped at the hard context limit while its retry runs (#272) and
// a large cumulative usage are never stopped.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { effectNames, effectsOf } from "./gh-effects.mjs";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  cfg,
  deadPid,
  fakeGh,
  NOW,
  OTHERS_PID,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { ghIsRead } = await import("../src/github.ts");

/** @import { StatusFile } from "../src/job/status.ts" */

const ISSUE = {
  atBudget: 90,
  over: 91,
  usage: 92,
  noBudget: 93,
  ops: 94,
  unended: 95,
  launchEnded: 96,
  retrying: 97,
};
const PR_OF_OVER = 19;
const BUDGET = 60_000;
// Past the budget, and with none of its digits in a row, so a comment that
// names one can't be mistaken for naming the other.
const OVER_BUDGET = 72_345;
// Far more than any budget, as a long session's summed usage gets.
const HUGE_USAGE = 5_000_000;
// The tick after the stop, in minutes after NOW.
const LATER_MINUTES = 3;
/** @type {StatusFile["outcome"]} */
const STOPPED = { kind: "stopped", signal: "SIGTERM" };

/** @param {number} issue @returns {string[]} */
function actionsOf(issue) {
  return loggedFor(issue).map(({ action, reason }) => `${action} ${reason}`);
}

// Drops the budget fields from issue `issue`'s job.json, as an older job
// wrote it.
/** @param {number} issue @returns {void} */
function asOldFile(issue) {
  const file = path.join(paths.runDir(cfg, issue), "job.json");
  const status = JSON.parse(fs.readFileSync(file, "utf8"));
  const launches = status.launches.map(
    (/** @type {Record<string, unknown>} */ launch) => {
      const { tokenBudget, contextTokens, ...old } = launch;
      return old;
    },
  );
  fs.writeFileSync(file, JSON.stringify({ ...status, launches }));
}

/** @param {number} issue @param {string} stage @param {number} [pr] */
function openIssue(issue, stage, pr) {
  if (pr === undefined) {
    return { number: issue, state: { stage } };
  }
  return { number: issue, state: { stage, pr } };
}

test("a session whose context reaches its budget exactly is left alone", () => {
  const job = { issue: ISSUE.atBudget, stage: "review", pid: OTHERS_PID };
  writeJob({ ...job, tokenBudget: BUDGET, contextTokens: BUDGET });
  const ticked = tickOver([openIssue(ISSUE.atBudget, "review")]);
  assert.deepEqual([ticked.terminated, ticked.spawned], [[], []]);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  assert.deepEqual(loggedFor(ISSUE.atBudget), []);
});

test("a session whose context passes its budget gets SIGTERM once, then its issue and PR are stopped with agent:stopped-budget and never restarted", () => {
  const job = { issue: ISSUE.over, stage: "review", pid: OTHERS_PID };
  const facts = { tokenBudget: BUDGET, contextTokens: OVER_BUDGET };
  writeJob({ ...job, ...facts });
  const issues = [openIssue(ISSUE.over, "review", PR_OF_OVER)];
  const first = tickOver(issues);
  assert.deepEqual(first.terminated, [OTHERS_PID]);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  const again = tickOver(issues, 1);
  assert.deepEqual([again.terminated, again.spawned], [[], []]);
  writeJob({ ...job, ...facts, pid: deadPid(), outcome: STOPPED });
  const stopped = tickOver(issues, 2);
  assert.deepEqual([stopped.terminated, stopped.spawned], [[], []]);
  const effects = effectsOf(fakeGh.writes(ghIsRead));
  const names = effectNames(effects);
  assert.ok(names.includes(`label #${ISSUE.over} agent:stopped-budget`));
  assert.ok(names.includes(`label #${PR_OF_OVER} agent:stopped-budget`));
  const key = `i${ISSUE.over}-review-1`;
  const comment = effects.find(({ body }) => body.includes(key));
  assert.ok(comment?.body.includes("token budget"));
  assert.ok(comment?.body.includes(String(OVER_BUDGET)));
  assert.ok(comment?.body.includes(String(BUDGET)));
  const later = tickOver(
    [
      {
        number: ISSUE.over,
        labels: ["agent:stopped-budget"],
        state: { stage: "stopped", pr: PR_OF_OVER },
      },
    ],
    LATER_MINUTES,
  );
  assert.deepEqual([later.terminated, later.spawned], [[], []]);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  assert.deepEqual(actionsOf(ISSUE.over), [
    `killed budget:${key}`,
    "stopped budget",
  ]);
});

test("a huge cumulative usage with the context under budget, a launch with no budget and an ops launch are never stopped", () => {
  writeJob({
    issue: ISSUE.usage,
    stage: "implement",
    pid: OTHERS_PID,
    tokens: HUGE_USAGE,
    tokenBudget: BUDGET,
    contextTokens: BUDGET - 1,
  });
  const old = { issue: ISSUE.noBudget, stage: "fix", pid: OTHERS_PID };
  writeJob({ ...old, contextTokens: HUGE_USAGE });
  asOldFile(ISSUE.noBudget);
  writeJob({
    issue: ISSUE.ops,
    stage: "sync",
    pid: OTHERS_PID,
    kind: "ops",
    tokenBudget: BUDGET,
    contextTokens: HUGE_USAGE,
  });
  const ticked = tickOver([
    openIssue(ISSUE.usage, "implement"),
    openIssue(ISSUE.noBudget, "fix"),
    openIssue(ISSUE.ops, "sync"),
  ]);
  assert.deepEqual([ticked.terminated, ticked.spawned], [[], []]);
  for (const issue of [ISSUE.usage, ISSUE.noBudget, ISSUE.ops]) {
    assert.deepEqual(loggedFor(issue), []);
  }
});

test("a session launch that has ended is never stopped, whatever its context", () => {
  writeJob({
    issue: ISSUE.launchEnded,
    stage: "review",
    pid: OTHERS_PID,
    tokenBudget: BUDGET,
    contextTokens: OVER_BUDGET,
    launchOutcome: "ok",
  });
  const ticked = tickOver([openIssue(ISSUE.launchEnded, "review")]);
  assert.deepEqual([ticked.terminated, ticked.spawned], [[], []]);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  assert.deepEqual(loggedFor(ISSUE.launchEnded), []);
});

// A long-silent session's minutes, past both the silence steer and SIGTERM.
const LONG_SILENT_MINUTES = 120;

test("a session stopped at the hard context limit, past its budget and silent, is left alone while its retry runs", () => {
  const status = writeJob({
    issue: ISSUE.retrying,
    stage: "review",
    pid: OTHERS_PID,
    silentMinutes: LONG_SILENT_MINUTES,
    tokenBudget: BUDGET,
    contextTokens: OVER_BUDGET,
  });
  const now = NOW.toISOString();
  const contextStop = { context: OVER_BUDGET, result: "error" };
  const launches = status.launches.flatMap((launch) => [
    { ...launch, contextStop },
    {
      ...launch,
      key: `${launch.key}.retry`,
      startedAt: now,
      lastEventAt: now,
      contextTokens: 0,
    },
  ]);
  const file = path.join(paths.runDir(cfg, ISSUE.retrying), "job.json");
  fs.writeFileSync(file, JSON.stringify({ ...status, launches }));
  const ticked = tickOver([openIssue(ISSUE.retrying, "review")]);
  assert.deepEqual([ticked.terminated, ticked.spawned], [[], []]);
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  assert.deepEqual(loggedFor(ISSUE.retrying), []);
});

test("a job that ends with no outcome after its budget SIGTERM is stopped, not resumed", () => {
  const job = { issue: ISSUE.unended, stage: "accept", pid: OTHERS_PID };
  const facts = { tokenBudget: BUDGET, contextTokens: BUDGET + 1 };
  writeJob({ ...job, ...facts });
  const issues = [openIssue(ISSUE.unended, "accept")];
  assert.deepEqual(tickOver(issues).terminated, [OTHERS_PID]);
  writeJob({ ...job, ...facts, pid: deadPid() });
  const after = tickOver(issues, 1);
  assert.deepEqual(after.spawned, []);
  const names = effectNames(effectsOf(fakeGh.writes(ghIsRead)));
  assert.ok(names.includes(`label #${ISSUE.unended} agent:stopped-budget`));
  assert.deepEqual(actionsOf(ISSUE.unended), [
    `killed budget:i${ISSUE.unended}-accept-1`,
    "stopped budget",
  ]);
});
