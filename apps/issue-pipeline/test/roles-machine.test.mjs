// @ts-check
// A role's machine as data (#301): the pure transition built from a table,
// its count guard, and checkTable's report of a table's faults.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTable, transitionOf } from "../src/roles/machine.ts";
import { TOY_ENTRIES, TOY_LIMITS, TOY_STATES, WORK } from "./runner-toys.mjs";

/** @import { ToyData, ToyStates } from "./runner-toys.mjs" */

/** @type {ToyData} */
const DATA = { tries: 0, plan: null, scratch: "" };

/** @param {ToyStates} states */
function tableOf(states) {
  return { entries: TOY_ENTRIES, states };
}

/** @param {ToyStates} states @param {Readonly<Record<string, number>>} [limits] */
function faults(states, limits = TOY_LIMITS) {
  return checkTable(tableOf(states), limits, DATA).join("\n");
}

const transition = transitionOf(tableOf(TOY_STATES), TOY_LIMITS);

test("transition follows the table's edges, applying the reply", () => {
  const posted = transition(
    { at: "post", data: DATA },
    { name: "ok", reply: null },
  );
  assert.deepEqual(posted, { state: { at: "work", data: DATA }, effect: WORK });
  const worked = transition(posted.state, {
    name: "replied",
    reply: { plan: "a plan" },
  });
  assert.equal(worked.state.at, "verify");
  assert.equal(worked.state.data.plan, "a plan");
  assert.equal(worked.effect.kind, "check");
});

test("transition throws on a result the state doesn't list", () => {
  assert.throws(() =>
    transition({ at: "post", data: DATA }, { name: "fail", reply: null }),
  );
});

test("a guarded edge adds 1 to its count until the limit", () => {
  const retried = transition(
    { at: "verify", data: { ...DATA, tries: TOY_LIMITS.maxTries - 1 } },
    { name: "fail", reply: null },
  );
  assert.equal(retried.state.at, "work");
  assert.equal(retried.state.data.tries, TOY_LIMITS.maxTries);
});

test("a guarded edge goes to its over-limit target at the limit", () => {
  const over = transition(
    { at: "verify", data: { ...DATA, tries: TOY_LIMITS.maxTries } },
    { name: "fail", reply: null },
  );
  assert.equal(over.state.at, "gave-up");
  assert.deepEqual(over.effect, {
    kind: "end",
    end: { kind: "stopped", code: "limit" },
  });
});

test("the toy table has no violations", () => {
  assert.deepEqual(checkTable(tableOf(TOY_STATES), TOY_LIMITS, DATA), []);
});

test("a cycle with no count guard is a violation", () => {
  const verify = { ...TOY_STATES.verify, on: { fail: { to: "work" } } };
  const found = faults({ ...TOY_STATES, verify });
  assert.ok(found.includes("verify"));
});

test("a guard whose limit isn't configured is a violation", () => {
  const found = faults(TOY_STATES, {});
  assert.ok(found.includes("maxTries"));
});

test("a state no entry reaches is a violation", () => {
  const orphan = { ...TOY_STATES.checks, on: { ok: { to: "finished" } } };
  const found = faults({ ...TOY_STATES, orphan });
  assert.ok(found.includes("orphan"));
});

test("a state from which no end can be reached is a violation", () => {
  const stuck = { ...TOY_STATES.checks, on: {} };
  const post = {
    ...TOY_STATES.post,
    on: { ok: { to: "work" }, held: { to: "stuck" } },
  };
  const found = faults({ ...TOY_STATES, post, stuck });
  assert.ok(found.includes("stuck"));
});

test("a session effect from a script state is a violation", () => {
  const post = { ...TOY_STATES.post, effect: () => WORK };
  const found = faults({ ...TOY_STATES, post });
  assert.ok(found.includes("post"));
});
