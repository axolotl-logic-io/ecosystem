// @ts-check
// A CI fixer or conflict resolver that runs out of room (#269): it hands off
// to a continuation of the same attempt, which isn't another CI fix or
// conflict fix, up to config maxContinuations per issue; past that the issue
// stops as too large. A resolver's continuation works on the rebase still in
// progress; past the cap the rebase is aborted first.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { next as checks } from "../src/workflow/stages/checks.ts";
import { next as sync } from "../src/workflow/stages/sync.ts";
import {
  after,
  CTX,
  contextWith,
  PATHS,
  replied,
  sessionResult,
  stateAt,
} from "./workflow-checks-test-kit.mjs";

/** @import { Launch, StageContext, StageMachine, Step } from "../src/workflow/stages/types.ts" */

const HARD_LIMIT = /\b225000 tokens\b/u;
const EFFORT_GUESS = /15 files|30 substantial tool calls/u;
const LEAD = `A previous session ran out of room. Read its handoff first: ${PATHS.handoffFile}. Where it lists the files and lines earlier sessions read, reread only what you need. Continue from the current branch state.`;
const HANDOFF = { status: "handoff", summary: "Half done." };
const FIXED = { status: "fixed", summary: "Fixed." };
const FAILED = { id: "test", pass: false, detail: "1 failed", tail: "3 != 2" };
const FAILING = {
  ok: true,
  headSha: "cccccccccccccccc",
  pass: false,
  checks: [FAILED],
};
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
};

/** @param {Step} step @returns {readonly [Launch, ...Launch[]]} */
function launchesOf(step) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  return step.launches;
}

/** @param {Step} step @returns {string} */
function firstTask(step) {
  const [launch] = launchesOf(step);
  if (launch.kind !== "child") {
    throw new Error(`expected a session, got ${launch.name}`);
  }
  return launch.task;
}

// The step after the one session `step` launched replies `reply`.
/** @param {StageMachine["next"]} next @param {Step} step @param {unknown} reply @param {StageContext} [ctx] @returns {Step} */
function answered(next, step, reply, ctx = CTX) {
  const [launch] = launchesOf(step);
  return after(next, step, ctx, sessionResult(launch.name, reply));
}

/** @param {number} maxContinuations @returns {StageContext} */
function allowing(maxContinuations) {
  return contextWith({ cfg: { ...CTX.cfg, maxContinuations } });
}

/** @param {StageContext} [ctx] @returns {Step} */
function ciFixing(ctx = CTX) {
  return replied(checks, checks(stateAt("checks"), ctx, []), FAILING, ctx);
}

/** @param {StageContext} [ctx] @returns {Step} */
function conflicted(ctx = CTX) {
  return replied(sync, sync(stateAt("sync"), ctx, []), CONFLICT, ctx);
}

describe("the writer prompts", () => {
  test("state the hard limit in tokens, not an effort guess", () => {
    for (const task of [firstTask(ciFixing()), firstTask(conflicted())]) {
      assert.match(task, HARD_LIMIT);
      assert.ok(task.includes(PATHS.handoffFile));
      assert.ok(task.includes("`handoff`"));
      assert.doesNotMatch(task, EFFORT_GUESS);
      assert.equal(task.includes(LEAD), false);
    }
  });
});

describe("a CI fixer's handoff", () => {
  test("launches a continuation for the same failure", () => {
    const fixing = ciFixing();
    const continuing = answered(checks, fixing, HANDOFF);
    const task = firstTask(continuing);
    assert.ok(task.includes(LEAD));
    assert.ok(task.includes("3 != 2"));
    assert.notEqual(launchesOf(continuing)[0].name, launchesOf(fixing)[0].name);
    assert.equal(continuing.state.st.ciFixes, 1);
    assert.deepEqual(continuing.state.st.continuations, { ciFix: 1 });
  });

  test("a continuation that fixes it pushes the fix", () => {
    const continuing = answered(checks, ciFixing(), HANDOFF);
    const pushing = answered(checks, continuing, FIXED);
    assert.equal(launchesOf(pushing)[0].name, "push");
    assert.equal(pushing.state.st.ciFixes, 1);
  });

  test("past maxContinuations stops the issue as too large", () => {
    const continuing = answered(checks, ciFixing(), HANDOFF);
    const stopped = answered(checks, continuing, HANDOFF);
    assert.equal(stopped.done, true);
    assert.equal(stopFor(stopped.stop?.reason)?.code, "too-large");
    const ctx = allowing(0);
    const first = answered(checks, ciFixing(ctx), HANDOFF, ctx);
    assert.equal(stopFor(first.stop?.reason)?.code, "too-large");
  });
});

describe("a conflict resolver's handoff", () => {
  test("launches a continuation on the rebase in progress, from the rebase pool", () => {
    const resolving = conflicted();
    const continuing = answered(sync, resolving, HANDOFF);
    const [launch] = launchesOf(continuing);
    assert.equal(launch.kind, "child");
    assert.notEqual(launch.name, launchesOf(resolving)[0].name);
    assert.ok(firstTask(continuing).includes(LEAD));
    assert.ok(firstTask(continuing).includes("src/a.ts"));
    assert.equal(continuing.state.st.conflictFixes, 1);
    assert.deepEqual(continuing.state.st.continuations, { conflicts: 1 });
  });

  test("past maxContinuations aborts the rebase, then stops as too large", () => {
    const continuing = answered(sync, conflicted(), HANDOFF);
    const aborting = answered(sync, continuing, HANDOFF);
    const [finish] = launchesOf(aborting);
    assert.ok(finish.kind === "op");
    const { abort } = finish.payload;
    assert.deepEqual([finish.op, abort], ["finish-sync", true]);
    const stopped = replied(sync, aborting, { ok: true, resolved: false });
    assert.equal(stopped.done, true);
    assert.equal(stopFor(stopped.stop?.reason)?.code, "too-large");
  });
});
