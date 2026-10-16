// @ts-check
// The role runner (#301): how failures end a run, the session refusal, what
// reaches the issue's state and when, signals, and that a run killed at any
// effect and started again from the saved state ends as an uninterrupted one
// does, with no comment posted twice.
import assert from "node:assert/strict";
import { test } from "node:test";
import { killAt, runToy, uninterrupted, world } from "./runner-test-kit.mjs";
import { TOY_LIMITS, TOY_STATES, toyMachine, WORK } from "./runner-toys.mjs";

/** @import { Call, ToyRole } from "./runner-test-kit.mjs" */

const NETWORK_ERROR = "error connecting to api.github.com";
const STEP_FAILED = { kind: "stopped", code: "error" };
/** @type {readonly ("before" | "after")[]} */
const KILL_POINTS = ["before", "after"];
/** @type {readonly ToyRole[]} */
const ROLES = ["machine", "linear"];

/** @param {number} tries @returns {string} the verify result: fail once */
function failOnce(tries) {
  if (tries === 0) {
    return "fail";
  }
  return "pass";
}

/** @returns {string} */
function alwaysFail() {
  return "fail";
}

/** @param {Call} call @returns {unknown} the count a save call saved */
function savedCount(call) {
  const { tries } = call.state?.checkpoints ?? {};
  return tries;
}

/** @param {readonly Call[]} calls @param {number} tries @returns {number} */
function countSave(calls, tries) {
  return calls.findIndex(
    (call) => call.kind === "save" && savedCount(call) === tries,
  );
}

/** @param {readonly Call[]} calls */
function sessions(calls) {
  return calls.filter((call) => call.kind === "session").length;
}

// Each role's uninterrupted run, which every killed run must end as. Made
// before any test is defined, so no test's fake gh calls come between.
const REFERENCES = {
  machine: await uninterrupted("machine", { verify: failOnce }),
  linear: await uninterrupted("linear", { verify: failOnce }),
};

test("a network error the state doesn't list ends held", async () => {
  const run = await uninterrupted("machine", {
    failOp: { "toy-post": NETWORK_ERROR },
  });
  assert.deepEqual(run.end, { kind: "held" });
});

test("another failure the state doesn't list ends stopped with error", async () => {
  const run = await uninterrupted("machine", {
    failOp: { "toy-post": "boom" },
  });
  assert.deepEqual(run.end, STEP_FAILED);
});

test("a failed result the state lists goes to its transition", async () => {
  const run = await uninterrupted("machine", { verifyFails: true });
  assert.deepEqual(run.end, { kind: "stopped", code: "broken" });
});

test("a session from a script state is refused and never runs", async () => {
  const post = { ...TOY_STATES.post, effect: () => WORK };
  const machine = toyMachine({ states: { ...TOY_STATES, post } });
  const place = world();
  const end = await runToy("machine", place, place.effects().effects, machine);
  assert.deepEqual(end, STEP_FAILED);
  assert.equal(sessions(place.calls), 0);
});

test("a failed save at an end ends the run as a failed step", async () => {
  const stopped = await uninterrupted("linear", { failSave: "boom" });
  assert.deepEqual(stopped.end, STEP_FAILED);
  const held = await uninterrupted("linear", { failSave: NETWORK_ERROR });
  assert.deepEqual(held.end, { kind: "held" });
});

test("only declared checkpoints and hand-off fields reach a save", async () => {
  const run = await uninterrupted("machine", { verify: failOnce });
  for (const call of run.calls.filter(({ kind }) => kind === "save")) {
    assert.equal(call.state !== undefined && "scratch" in call.state, false);
    assert.deepEqual(Object.keys(call.state?.checkpoints ?? {}), ["tries"]);
  }
  assert.deepEqual(run.end, { kind: "saved", stage: "merge" });
  assert.deepEqual(run.saved, {
    version: 1,
    number: 7,
    stage: "merge",
    lease: null,
    plan: "toy plan",
    checkpoints: { tries: 1 },
  });
});

test("a count is saved as soon as it goes up", async () => {
  const run = await uninterrupted("machine", { verify: failOnce });
  const secondSession = run.calls.findLastIndex(
    ({ kind }) => kind === "session",
  );
  const saved = countSave(run.calls, 1);
  assert.ok(saved >= 0 && saved < secondSession);
});

test("a killed and restarted run keeps the loop's limit", async () => {
  const options = { verify: alwaysFail };
  const reference = await uninterrupted("machine", options);
  const limited = { kind: "stopped", code: "limit" };
  assert.deepEqual(reference.end, limited);
  assert.equal(sessions(reference.calls), TOY_LIMITS.maxTries + 1);
  const k = countSave(reference.calls, 2) + 1;
  assert.ok(k > 0);
  const run = await killAt("machine", { k, when: "after" }, options);
  assert.deepEqual(run.end, limited);
  assert.deepEqual(run.saved.checkpoints, { tries: TOY_LIMITS.maxTries });
  assert.equal(sessions(run.calls), sessions(reference.calls));
});

test("a next end saves before the next stage's first effect", async () => {
  const run = await uninterrupted("machine");
  const saved = run.calls.findIndex(
    (call) => call.kind === "save" && call.state?.stage === "checks",
  );
  const checks = run.calls.findIndex(({ name }) => name === "toy-checks");
  assert.ok(saved >= 0 && saved < checks);
});

test("a pending signal ends the run with no further effect", async () => {
  const place = world({ signalAt: 1 });
  const end = await runToy("machine", place, place.effects().effects);
  assert.deepEqual(end, { kind: "interrupted", signal: "SIGTERM" });
  assert.equal(place.calls.length, 1);
});

for (const role of ROLES) {
  const reference = REFERENCES[role];
  test(`a ${role} role posts each comment once`, () => {
    const posts = reference.writes.map((args) => args.join(" "));
    assert.equal(posts.length, 2);
    assert.equal(new Set(posts).size, posts.length);
  });
  for (let k = 1; k <= reference.calls.length; k += 1) {
    for (const when of KILL_POINTS) {
      test(`a ${role} role killed ${when} call ${k} ends as an uninterrupted one`, async () => {
        const run = await killAt(role, { k, when }, { verify: failOnce });
        assert.deepEqual(run.end, reference.end);
        assert.deepEqual(run.saved, reference.saved);
        assert.deepEqual(run.writes, reference.writes);
      });
    }
  }
}
