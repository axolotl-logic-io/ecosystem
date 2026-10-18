// @ts-check
// The watchdog's restarts under the scheduler's limits (#235's review): a
// dead job is restarted only when a start would be, so tokensPerHour,
// maxJobs and the stage caps cover the restarts too. A held restart is
// logged with the scheduler's reason, isn't counted against maxResumes, and
// starts nothing else for its issue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  cfg,
  configWith,
  deadPid,
  OTHERS_PID,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");

const ISSUE = { rated: 80, capped: 81, running: 82 };
const TOKENS_PER_HOUR = 1000;
// More ticks than the default maxResumes (2) allows restarts.
const HELD_TICKS = 3;

/** @param {number} issue @returns {string[]} */
function actionsOf(issue) {
  return loggedFor(issue).map(({ action, reason }) => `${action} ${reason}`);
}

test("once the last hour's tokens reach tokensPerHour a dead job is held for the rate limit, uncounted, and restarted when a start may run", () => {
  const rated = loadConfig(configWith({ tokensPerHour: TOKENS_PER_HOUR }));
  writeJob({
    issue: ISSUE.rated,
    stage: "fix",
    pid: deadPid(),
    tokens: TOKENS_PER_HOUR,
  });
  const issues = [{ number: ISSUE.rated, state: { stage: "fix" } }];
  for (let at = 0; at < HELD_TICKS; at += 1) {
    assert.deepEqual(tickOver(issues, 0, { config: rated }).spawned, []);
  }
  const { spawned } = tickOver(issues, 0, { config: cfg });
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0]?.includes("--resume"));
  assert.deepEqual(actionsOf(ISSUE.rated), [
    ...new Array(HELD_TICKS).fill("held rate-limit"),
    "resumed dead",
  ]);
});

test("a dead job is held while maxJobs jobs are live", () => {
  const single = loadConfig(configWith({ maxJobs: 1 }));
  writeJob({ issue: ISSUE.running, stage: "spec", pid: OTHERS_PID });
  writeJob({ issue: ISSUE.capped, stage: "implement", pid: deadPid() });
  const issues = [
    { number: ISSUE.running, state: { stage: "spec" } },
    { number: ISSUE.capped, state: { stage: "implement" } },
  ];
  assert.deepEqual(tickOver(issues, 0, { config: single }).spawned, []);
  assert.deepEqual(actionsOf(ISSUE.capped), ["held global-cap"]);
});
