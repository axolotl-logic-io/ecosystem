// @ts-check
// The watchdog's thresholds come from the repo config (#235): maxResumes,
// silentMinutes and failureStreak each set where their rule fires, at the
// configured value and not one below it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  configWith,
  deadPid,
  OTHERS_PID,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");

const ISSUE = { capped: 90, silent: 91, failing: 92 };
// Each below its default (2, 30 and 3), so a rule that ignored the config
// would fire later than these.
const MAX_RESUMES = 1;
const SILENT_MINUTES = 5;
const FAILURE_STREAK = 2;
const config = loadConfig(
  configWith({
    maxResumes: MAX_RESUMES,
    silentMinutes: SILENT_MINUTES,
    failureStreak: FAILURE_STREAK,
  }),
);
const options = { config };

/** @param {number} issue @returns {string[]} */
function actionsOf(issue) {
  return loggedFor(issue).map(({ action, reason }) => `${action} ${reason}`);
}

test("a configured maxResumes stops the issue after that many restarts", () => {
  writeJob({ issue: ISSUE.capped, stage: "review", pid: deadPid() });
  const issues = [{ number: ISSUE.capped, state: { stage: "review" } }];
  assert.equal(tickOver(issues, 0, options).spawned.length, MAX_RESUMES);
  assert.deepEqual(tickOver(issues, 0, options).spawned, []);
  assert.deepEqual(actionsOf(ISSUE.capped), [
    "resumed dead",
    "stopped max-resumes",
  ]);
});

test("a configured silentMinutes sets when a silent session is steered and when its job gets SIGTERM", () => {
  const job = { issue: ISSUE.silent, stage: "implement", pid: OTHERS_PID };
  const issues = [{ number: ISSUE.silent, state: { stage: "implement" } }];
  writeJob({ ...job, silentMinutes: SILENT_MINUTES - 1 });
  assert.deepEqual(tickOver(issues, 0, options).steered, []);
  writeJob({ ...job, silentMinutes: SILENT_MINUTES });
  assert.equal(tickOver(issues, 0, options).steered.length, 1);
  const waiting = tickOver(issues, SILENT_MINUTES - 1, options);
  assert.deepEqual(waiting.terminated, []);
  const due = tickOver(issues, SILENT_MINUTES, options);
  assert.deepEqual(due.terminated, [OTHERS_PID]);
});

test("a configured failureStreak sets how many failed calls of one tool steer the session", () => {
  const issues = [{ number: ISSUE.failing, state: { stage: "implement" } }];
  /** @param {number} count @returns {void} */
  function failedTimes(count) {
    const failures = { count, tool: "read", error: "ENOENT" };
    writeJob({
      issue: ISSUE.failing,
      stage: "implement",
      pid: OTHERS_PID,
      failures,
    });
  }
  failedTimes(FAILURE_STREAK - 1);
  assert.deepEqual(tickOver(issues, 0, options).steered, []);
  failedTimes(FAILURE_STREAK);
  assert.equal(tickOver(issues, 0, options).steered.length, 1);
  const key = `i${ISSUE.failing}-implement-1`;
  assert.deepEqual(actionsOf(ISSUE.failing), [`steered failures:${key}`]);
});
