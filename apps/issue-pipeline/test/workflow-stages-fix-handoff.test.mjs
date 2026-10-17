// @ts-check
// A review fixer that runs out of room (#269): it hands off to a continuation
// in the same fix round, which isn't another round, up to config
// maxContinuations per issue; past that the issue stops as too large.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { next } from "../src/workflow/stages/fix.ts";
import { FIXED, fixState } from "./workflow-fix-test-kit.mjs";
import { CTX, ITEM, replied } from "./workflow-review-test-kit.mjs";

/** @import { Launch, StageContext, StageState, Step } from "../src/workflow/stages/types.ts" */

const HARD_LIMIT = /\b225000 tokens\b/u;
const EFFORT_GUESS = /15 files|30 substantial tool calls/u;
const HANDOFF = { ...FIXED, status: "handoff", summary: "Half fixed." };
const LEAD = `A previous session ran out of room. Read its handoff first: ${ITEM.paths.handoffFile}. Continue from the current branch state.`;

/** @param {Step} step @returns {readonly [Launch, ...Launch[]]} */
function launchesOf(step) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  return step.launches;
}

/** @param {Launch} launch @returns {string} */
function taskOf(launch) {
  if (launch.kind !== "child") {
    throw new Error(`expected a session, got ${launch.name}`);
  }
  return launch.task;
}

// The fix step after the fixer begun from `state` replies `reply`.
/** @param {StageState} state @param {unknown} reply @param {StageContext} [ctx] @returns {{ begun: Step, fixed: Step }} */
function fixedWith(state, reply, ctx = CTX) {
  const begun = next(state, ctx, []);
  const [fixer] = launchesOf(begun);
  return { begun, fixed: next(begun.state, ctx, [replied(fixer.name, reply)]) };
}

/** @param {number} maxContinuations @returns {StageContext} */
function allowing(maxContinuations) {
  return { ...CTX, cfg: { ...CTX.cfg, maxContinuations } };
}

test("the fixer's prompt states the hard limit in tokens, not an effort guess", () => {
  const task = taskOf(launchesOf(next(fixState(), CTX, []))[0]);
  assert.match(task, HARD_LIMIT);
  assert.ok(task.includes(ITEM.paths.handoffFile));
  assert.ok(task.includes("`handoff`"));
  assert.doesNotMatch(task, EFFORT_GUESS);
  assert.equal(task.includes(LEAD), false);
});

test("a fixer's handoff launches a continuation in the same round", () => {
  const { begun, fixed } = fixedWith(fixState(), HANDOFF);
  const [continuation] = launchesOf(fixed);
  assert.equal(continuation.kind, "child");
  assert.equal(continuation.kind === "child" && continuation.writer, true);
  assert.ok(taskOf(continuation).includes(LEAD));
  assert.notEqual(continuation.name, launchesOf(begun)[0].name);
  assert.equal(fixed.state.st.round, 1);
  assert.deepEqual(fixed.state.st.continuations, { fix: 1 });
});

test("a continuation that finishes pushes the fix", () => {
  const { fixed } = fixedWith(fixState(), HANDOFF);
  const [continuation] = launchesOf(fixed);
  const done = next(fixed.state, CTX, [replied(continuation.name, FIXED)]);
  assert.deepEqual(launchesOf(done), [
    { kind: "op", name: "push", op: "push", payload: { number: 7 } },
  ]);
  assert.equal(done.state.st.round, 1);
});

test("a handoff past maxContinuations stops the issue as too large", () => {
  const { fixed } = fixedWith(fixState(), HANDOFF);
  const [continuation] = launchesOf(fixed);
  const again = next(fixed.state, CTX, [replied(continuation.name, HANDOFF)]);
  assert.equal(again.done, true);
  assert.equal(stopFor(again.stop?.reason)?.code, "too-large");
  assert.equal(again.state.st.round, 1);
});

test("with maxContinuations 0 the first handoff stops", () => {
  const { fixed } = fixedWith(fixState(), HANDOFF, allowing(0));
  assert.equal(fixed.done, true);
  assert.equal(stopFor(fixed.stop?.reason)?.code, "too-large");
});
