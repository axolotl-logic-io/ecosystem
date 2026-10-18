// @ts-check
// Whole ticks with only some roles running (#417): an issue whose next stage
// belongs to a role that is off is held `role-off:<role>` with its state and
// labels unchanged, while the running roles' issues start; the roles come
// from the caller, else the config's orchestratorRoles. A dead job of a role
// that is off isn't restarted or counted, a live one still counts toward
// maxJobs, and the safety actions (the steer, the maxResumes stop) still
// happen for it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { effectNames, effectsOf } from "./gh-effects.mjs";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  configWith,
  deadPid,
  fakeGh,
  OTHERS_PID,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { ghIsRead } = await import("../src/github.ts");

/** @import { RoleName } from "../src/roles/registry.ts" */

const ISSUE = {
  reviewing: 80,
  fresh: 81,
  configured: 82,
  deadFix: 83,
  liveImplement: 84,
  waiting: 85,
  silent: 86,
  capped: 87,
};
const PR_OF_REVIEWING = 8;
const PR_OF_CAPPED = 9;
const SILENT_MINUTES = 30;
/** @type {RoleName[]} */
const TRIAGE_ONLY = ["triage"];

// What the issue's lines in orchestrator.log say, as `action reason`.
/** @param {number} issue @returns {string[]} */
function said(issue) {
  return loggedFor(issue).map(({ action, reason }) => `${action} ${reason}`);
}

// The issues the tick's spawns started, with their stages.
/** @param {string[][]} spawned @returns {string[]} */
function startsOf(spawned) {
  return spawned.map((argv) => {
    const issue = argv[argv.indexOf("--issue") + 1];
    const stage = argv[argv.indexOf("--stage") + 1];
    return `#${issue} ${stage}`;
  });
}

test("with --roles triage, an issue at review is held role-off:reviewer with its state and labels unchanged, while a triage issue starts", () => {
  const { spawned } = tickOver(
    [
      {
        number: ISSUE.reviewing,
        state: { stage: "review", pr: PR_OF_REVIEWING },
      },
      { number: ISSUE.fresh },
    ],
    0,
    { roles: TRIAGE_ONLY },
  );
  assert.deepEqual(fakeGh.writes(ghIsRead), []);
  assert.deepEqual(startsOf(spawned), [`#${ISSUE.fresh} triage`]);
  assert.deepEqual(said(ISSUE.reviewing), ["held role-off:reviewer"]);
  assert.deepEqual(said(ISSUE.fresh), ["started free"]);
});

test("with no roles given, the tick runs the config's orchestratorRoles, and given roles override them", () => {
  const reviewersOnly = loadConfig(
    configWith({ orchestratorRoles: ["reviewer"] }),
  );
  const issues = [{ number: ISSUE.configured }];
  const fromConfig = tickOver(issues, 0, { config: reviewersOnly });
  assert.deepEqual(fromConfig.spawned, []);
  assert.deepEqual(said(ISSUE.configured), ["held role-off:triage"]);
  const overridden = tickOver(issues, 0, {
    config: reviewersOnly,
    roles: TRIAGE_ONLY,
  });
  assert.deepEqual(startsOf(overridden.spawned), [
    `#${ISSUE.configured} triage`,
  ]);
});

test("a dead fix job with the implementor off isn't restarted or counted toward maxResumes", () => {
  const oneRestart = loadConfig(configWith({ maxResumes: 1 }));
  writeJob({ issue: ISSUE.deadFix, stage: "fix", pid: deadPid() });
  const issues = [{ number: ISSUE.deadFix, state: { stage: "fix" } }];
  const off = { config: oneRestart, roles: TRIAGE_ONLY };
  assert.deepEqual(tickOver(issues, 0, off).spawned, []);
  assert.deepEqual(tickOver(issues, 1, off).spawned, []);
  // Had either held restart counted, this one would stop the issue.
  const on = tickOver(issues, 2, { config: oneRestart });
  assert.deepEqual(startsOf(on.spawned), [`#${ISSUE.deadFix} fix`]);
  assert.deepEqual(said(ISSUE.deadFix), [
    "held role-off:implementor",
    "held role-off:implementor",
    "resumed dead",
  ]);
});

test("a live job of a role that is off still counts toward maxJobs", () => {
  const oneJob = loadConfig(configWith({ maxJobs: 1 }));
  writeJob({ issue: ISSUE.liveImplement, stage: "implement", pid: OTHERS_PID });
  const { spawned } = tickOver(
    [
      { number: ISSUE.liveImplement, state: { stage: "implement" } },
      { number: ISSUE.waiting },
    ],
    0,
    { config: oneJob, roles: TRIAGE_ONLY },
  );
  assert.deepEqual(spawned, []);
  assert.deepEqual(said(ISSUE.waiting), ["held global-cap"]);
});

test("a silent session of a role that is off is still steered", () => {
  writeJob({
    issue: ISSUE.silent,
    stage: "implement",
    pid: OTHERS_PID,
    silentMinutes: SILENT_MINUTES,
  });
  const { steered } = tickOver(
    [{ number: ISSUE.silent, state: { stage: "implement" } }],
    0,
    { roles: TRIAGE_ONLY },
  );
  assert.equal(steered.length, 1);
  assert.deepEqual(said(ISSUE.silent), [
    `steered silent:i${ISSUE.silent}-implement-1`,
  ]);
});

test("a dead job past maxResumes still stops its issue with agent:stopped-job when its role is off", () => {
  const noRestarts = loadConfig(configWith({ maxResumes: 0 }));
  writeJob({ issue: ISSUE.capped, stage: "review", pid: deadPid() });
  const { spawned } = tickOver(
    [{ number: ISSUE.capped, state: { stage: "review", pr: PR_OF_CAPPED } }],
    0,
    { config: noRestarts, roles: TRIAGE_ONLY },
  );
  assert.deepEqual(spawned, []);
  const names = effectNames(effectsOf(fakeGh.writes(ghIsRead)));
  assert.ok(names.includes(`label #${ISSUE.capped} agent:stopped-job`));
  assert.deepEqual(said(ISSUE.capped), ["stopped max-resumes"]);
});
