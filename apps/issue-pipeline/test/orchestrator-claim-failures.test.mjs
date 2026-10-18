// @ts-check
// An issue whose claim keeps failing (#430): when its stage jobs end with the
// same claim error claimFailureStreak times in a row (default 3), the tick
// stops the issue with agent:stopped-error, the error in the stop comment and
// how to resume, and logs `stopped claim-failed`. Fewer failures are retried
// as before; a claim that passes, a different error, or lifting the stop
// starts the count again. Each tick here follows one more ended job, written
// as job.json with its own startedAt, as the job the tick before started.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyOf, effectNames, effectsOf, stateOf } from "./gh-effects.mjs";
import { loggedFor, tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  configWith,
  deadPid,
  fakeGh,
  NOW,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { ghIsRead } = await import("../src/github.ts");

/** @import { Config } from "../src/config.ts" */
/** @import { GhEffect } from "./gh-effects.mjs" */

const ISSUE = { same: 90, differs: 91, passes: 92, lifted: 93, setting: 94 };
const STAGE = "spec";
const STOP_LABEL = "agent:stopped-error";
const MS_PER_SECOND = 1000;
// Two claim errors, as the claim op's reply gives them.
const THREW =
  "claim threw: Cannot read properties of undefined (reading 'stage')";
const OTHER = "claim threw: the saved state comment doesn't parse";
const AT_SPEC = { stage: STAGE };
// The state the stop saves, which a lifted issue keeps until a claim passes.
const STOPPED_AT_SPEC = {
  stage: "stopped",
  stoppedStage: STAGE,
  stopCode: "error",
};
const STATE_EFFECT = / state$/u;

let jobsEnded = 0;

/**
 * One tick after issue `number`'s next spec job ended: its claim failed with
 * `claimError`, or passed when that is null. The issue is saved at `state`.
 * @param {number} number
 * @param {string | null} claimError
 * @param {{ state?: object, config?: Config }} [options]
 * @returns {{ spawned: string[][], effects: GhEffect[] }}
 */
function tickAfterJob(number, claimError, options = {}) {
  const { state = AT_SPEC, config } = options;
  jobsEnded += 1;
  /** @type {{ kind: "finished", claimError?: string }} */
  const outcome = { kind: "finished" };
  if (claimError !== null) {
    outcome.claimError = claimError;
  }
  writeJob({
    issue: number,
    stage: STAGE,
    pid: deadPid(),
    outcome,
    startedAt: new Date(
      NOW.getTime() + jobsEnded * MS_PER_SECOND,
    ).toISOString(),
  });
  /** @type {{ config?: Config }} */
  const tickOptions = {};
  if (config !== undefined) {
    tickOptions.config = config;
  }
  const { spawned } = tickOver([{ number, state }], 0, tickOptions);
  return { spawned, effects: effectsOf(fakeGh.writes(ghIsRead)) };
}

/** @param {number} number @param {{ effects: GhEffect[] }} ticked @returns {boolean} */
function stopped(number, { effects }) {
  return effectNames(effects).includes(`label #${number} ${STOP_LABEL}`);
}

// The stage of each job a tick started.
/** @param {readonly string[][]} spawned @returns {string[]} */
function stagesOf(spawned) {
  return spawned.map((argv) => String(argv[argv.indexOf("--stage") + 1]));
}

// The stop comment's text on issue `number`.
/** @param {number} number @param {{ effects: GhEffect[] }} ticked @returns {string} */
function stopComment(number, { effects }) {
  return bodyOf(effects, `comment #${number} role=coordinator`);
}

// The state the tick saved for its one issue.
/** @param {{ effects: GhEffect[] }} ticked @returns {any} */
function savedState({ effects }) {
  const saved = effects.find(({ effect }) => STATE_EFFECT.test(effect));
  if (saved === undefined) {
    throw new Error(`no state saved among ${effectNames(effects).join(", ")}`);
  }
  return stateOf(effects, saved.effect);
}

// The reasons of the `stopped` lines the ticks logged for `number`.
/** @param {number} number @returns {string[]} */
function stopsLogged(number) {
  return loggedFor(number)
    .filter(({ action }) => action === "stopped")
    .map(({ reason }) => reason);
}

test("a claim failing with the same error is retried twice, and the third failure stops the issue with agent:stopped-error, the error and how to resume", () => {
  const n = ISSUE.same;
  for (const retried of [tickAfterJob(n, THREW), tickAfterJob(n, THREW)]) {
    assert.equal(stopped(n, retried), false);
    assert.deepEqual(stagesOf(retried.spawned), [STAGE]);
  }
  const third = tickAfterJob(n, THREW);
  assert.equal(stopped(n, third), true);
  assert.deepEqual(third.spawned, []);
  const comment = stopComment(n, third);
  assert.ok(comment.includes(THREW), comment);
  assert.ok(comment.includes(`remove \`${STOP_LABEL}\``), comment);
  const { stage, stoppedStage, stopCode } = savedState(third);
  assert.deepEqual(
    { stage, stoppedStage, stopCode },
    { stage: "stopped", stoppedStage: STAGE, stopCode: "error" },
  );
  assert.deepEqual(stopsLogged(n), ["claim-failed"]);
});

test("a different claim error starts the count again, and the stop names the error that repeated", () => {
  const n = ISSUE.differs;
  for (const error of [THREW, THREW, OTHER, OTHER]) {
    assert.equal(stopped(n, tickAfterJob(n, error)), false, error);
  }
  const third = tickAfterJob(n, OTHER);
  assert.equal(stopped(n, third), true);
  const comment = stopComment(n, third);
  assert.ok(comment.includes(OTHER), comment);
  assert.equal(comment.includes(THREW), false, comment);
});

test("a claim that passes starts the count again", () => {
  const n = ISSUE.passes;
  for (const error of [THREW, THREW, null, THREW, THREW]) {
    assert.equal(stopped(n, tickAfterJob(n, error)), false, String(error));
  }
  assert.equal(stopped(n, tickAfterJob(n, THREW)), true);
  assert.deepEqual(stopsLogged(n), ["claim-failed"]);
});

test("lifting the stop starts the count again: the lifted issue is tried, and stops again only after three more failures, at its stopped stage", () => {
  const n = ISSUE.lifted;
  tickAfterJob(n, THREW);
  tickAfterJob(n, THREW);
  assert.equal(stopped(n, tickAfterJob(n, THREW)), true);
  // The stop label stays a tick, then is removed; job.json is the last job's.
  tickOver([{ number: n, labels: [STOP_LABEL], state: STOPPED_AT_SPEC }]);
  const lifted = tickOver([{ number: n, state: STOPPED_AT_SPEC }]);
  assert.deepEqual(stagesOf(lifted.spawned), [STAGE]);
  assert.equal(
    stopped(n, { effects: effectsOf(fakeGh.writes(ghIsRead)) }),
    false,
  );
  // The lifted issue's claims fail before they save anything.
  const options = { state: STOPPED_AT_SPEC };
  for (const retried of [
    tickAfterJob(n, THREW, options),
    tickAfterJob(n, THREW, options),
  ]) {
    assert.equal(stopped(n, retried), false);
    assert.deepEqual(stagesOf(retried.spawned), [STAGE]);
  }
  const again = tickAfterJob(n, THREW, options);
  assert.equal(stopped(n, again), true);
  const { stage, stoppedStage } = savedState(again);
  assert.deepEqual(
    { stage, stoppedStage },
    { stage: "stopped", stoppedStage: STAGE },
  );
  assert.deepEqual(stopsLogged(n), ["claim-failed", "claim-failed"]);
});

test("claimFailureStreak sets how many failures in a row stop the issue", () => {
  const n = ISSUE.setting;
  const config = loadConfig(configWith({ claimFailureStreak: 2 }));
  assert.equal(stopped(n, tickAfterJob(n, THREW, { config })), false);
  assert.equal(stopped(n, tickAfterJob(n, THREW, { config })), true);
});
