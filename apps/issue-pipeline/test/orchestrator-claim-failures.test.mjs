// @ts-check
// The orchestrator's failing-claim rule (#430) on jobs of this pipeline: the
// third job in a row whose claim fails with one error stops the issue with
// agent:stopped-error at the stage they ran, a different error starts the
// count again, and a claim that passes clears it.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { bodyOf, effectNames, effectsOf } from "./gh-effects.mjs";
import {
  fakeGh,
  ghIsRead,
  NOW,
  openWith,
  resetRuns,
  tickOver,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

/** @import { GhEffect } from "./gh-effects.mjs" */

const STAGE = "implement";
const STOP_LABEL = "agent:stopped-error";
const MS_PER_SECOND = 1000;
const DEAD_PID = 4343;
const THREW = "claim threw: the saved state comment doesn't parse";
const OTHER = "claim threw: gh is not logged in";

let jobsEnded = 0;

beforeEach(resetRuns);

// One tick after issue `number`'s next job ended, its claim failed with
// `claimError`, or passed when that is null.
/** @param {number} number @param {string | null} claimError @returns {{ spawned: string[][], effects: GhEffect[] }} */
function tickAfterJob(number, claimError) {
  jobsEnded += 1;
  /** @type {{ kind: "finished", claimError?: string }} */
  const outcome = { kind: "finished" };
  if (claimError !== null) {
    outcome.claimError = claimError;
  }
  writeJob({
    issue: number,
    stage: STAGE,
    pid: DEAD_PID,
    outcome,
    startedAt: new Date(
      NOW.getTime() + jobsEnded * MS_PER_SECOND,
    ).toISOString(),
  });
  openWith([{ number, state: { version: 2, number, stage: STAGE } }]);
  const { spawned } = tickOver();
  return { spawned, effects: effectsOf(fakeGh.writes(ghIsRead)) };
}

/** @param {number} number @param {{ effects: GhEffect[] }} ticked @returns {boolean} */
function stopped(number, { effects }) {
  return effectNames(effects).includes(`label #${number} ${STOP_LABEL}`);
}

test("a claim failing with one error three times in a row stops the issue with the error", () => {
  for (const retried of [tickAfterJob(1, THREW), tickAfterJob(1, THREW)]) {
    assert.equal(stopped(1, retried), false);
    assert.equal(retried.spawned.length, 1);
  }
  const third = tickAfterJob(1, THREW);
  assert.equal(stopped(1, third), true);
  assert.deepEqual(third.spawned, []);
  const text = bodyOf(third.effects, "comment #1 role=coordinator");
  assert.ok(text.includes("claim failed 3 times in a row"), text);
  assert.ok(text.includes(THREW), text);
});

test("a different error starts the count again, and a passing claim clears it", () => {
  tickAfterJob(2, THREW);
  tickAfterJob(2, THREW);
  assert.equal(stopped(2, tickAfterJob(2, OTHER)), false);
  tickAfterJob(2, null);
  tickAfterJob(2, OTHER);
  assert.equal(stopped(2, tickAfterJob(2, OTHER)), false);
});
