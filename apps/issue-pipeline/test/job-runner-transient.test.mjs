// @ts-check
// The role runner owns a session's transient provider error (#446,
// `rate-limit-defers`): a rate limit, an overload or a transport error ends
// the run held as rate-limited even where the role takes the session's
// failure itself (a machine state that lists `failed`, a linear step with
// `recover`), with the counts the run took put back and no stop op run,
// unless a linear step defers the error itself. Any other failure still goes
// to the role's own `failed` edge or `recover`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runLinear, runMachine } from "../src/job/runner.ts";
import { gh, runToy, uninterrupted, world } from "./runner-test-kit.mjs";
import { TOY_SCRIPT, TOY_STATES, toyMachine } from "./runner-toys.mjs";

/** @import { End } from "../src/roles/machine.ts" */
/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { Call, OpFake, RoleRun } from "./runner-test-kit.mjs" */
/** @import { State } from "../src/state.ts" */
/** @import { ToyData } from "./runner-toys.mjs" */

const RATE_LIMIT_ERROR =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"cooling down"}}';
// #369's implementer error (#385): a transport error in an api_error.
const CONNECTION_RESET =
  "api_error: read tcp 10.0.0.5:51234->1.2.3.4:443: read: connection reset by peer";
const OVERLOADED = '529 {"type":"error","error":{"type":"overloaded_error"}}';
const TRANSIENT = [
  { name: "a rate limit", error: RATE_LIMIT_ERROR },
  { name: "a transport error", error: "read ECONNRESET" },
  { name: "a connection reset in an api_error", error: CONNECTION_RESET },
  { name: "an overload", error: OVERLOADED },
];
const HELD = { kind: "held", rateLimited: true };
// The one retry the toy's failed edge allows, as the spec writer's does.
const LIMITS = { maxTries: 1 };
/** @type {End} the toy's stop once its session failed twice */
const GAVE_UP = {
  kind: "stopped",
  code: "limit",
  after: { op: "stop", payload: { reason: "the toy failed twice" } },
};
/** @type {Outcome} */
const REPLIED = { ok: true, name: "replied", reply: { plan: "toy plan" } };

// The toy machine with a session state that takes its own failure: a
// failed session runs again once, then the run stops with a stop op.
const TAKES_FAILURE = toyMachine({
  limits: LIMITS,
  states: {
    ...TOY_STATES,
    work: {
      ...TOY_STATES.work,
      on: {
        ...TOY_STATES.work.on,
        failed: {
          to: "work",
          count: { field: "tries", limit: "maxTries", over: "gave-up" },
        },
      },
    },
    "gave-up": {
      kind: "end",
      effect: () => ({ kind: "end", end: GAVE_UP }),
      on: {},
    },
  },
});

/** @type {RoleRun} */
function runTakesFailure(entry, effects) {
  return runMachine(TAKES_FAILURE, entry, effects);
}

/** @param {ToyData} data @returns {ToyData} */
function recovered(data) {
  return { ...data, plan: "recovered" };
}

/** @param {ToyData} data @returns {ToyData} */
function deferred(data) {
  return { ...data, plan: "deferred" };
}

// The toy linear script, its session step recovering from a failure, and
// deferring a transient provider error itself when `defers` holds.
/** @param {boolean} defers @returns {RoleRun} */
function recovering(defers) {
  const steps = TOY_SCRIPT.steps.map((step) => {
    if (step.kind !== "session") {
      return step;
    }
    if (defers) {
      return { ...step, recover: recovered, defer: deferred };
    }
    return { ...step, recover: recovered };
  });
  return (entry, effects) =>
    runLinear({ ...TOY_SCRIPT, steps }, entry, effects);
}

const runRecovering = recovering(false);
const runDeferring = recovering(true);

/** @type {OpFake} a stop that marks the store stopped */
function stop(store) {
  return {
    write: () => store.labels.add("stopped"),
    reply: { ok: true, name: "ok", reply: { ok: true } },
  };
}

/** @param {readonly Call[]} calls @returns {number} */
function sessions(calls) {
  return calls.filter(({ kind }) => kind === "session").length;
}

/** @param {readonly Call[]} calls @returns {number} the stop ops run */
function stops(calls) {
  return calls.filter(({ kind, name }) => kind === "op" && name === "stop")
    .length;
}

/** @param {State} saved @returns {unknown} the toy's saved count */
function triesOf(saved) {
  const { tries } = saved.checkpoints ?? {};
  return tries ?? 0;
}

/**
 * Sessions that come to `outcomes` in turn, then reply.
 * @param {readonly Outcome[]} outcomes
 * @returns {() => Outcome}
 */
function inTurn(outcomes) {
  let made = 0;
  return () => {
    const outcome = outcomes[made] ?? REPLIED;
    made += 1;
    return outcome;
  };
}

for (const { name, error } of TRANSIENT) {
  test(`${name} in a session state that lists failed ends held as rate-limited, with no retry and no stop`, async () => {
    const run = await uninterrupted(runTakesFailure, {
      session: { ok: false, error },
      ops: { stop },
    });
    assert.deepEqual(run.end, HELD);
    assert.equal(sessions(run.calls), 1);
    assert.equal(stops(run.calls), 0);
    assert.deepEqual(run.labels, []);
    assert.equal(triesOf(run.saved), 0);
    const { lease, stage } = run.saved;
    assert.deepEqual({ lease, stage }, { lease: null, stage: "implement" });
  });
}

test("a rate limit in a linear session step that recovers ends held, and the step's recover never runs", async () => {
  const run = await uninterrupted(runRecovering, {
    session: { ok: false, error: RATE_LIMIT_ERROR },
  });
  assert.deepEqual(run.end, HELD);
  const { plan, stage } = run.saved;
  assert.deepEqual({ plan, stage }, { plan: null, stage: "implement" });
  assert.equal(
    run.calls.some(({ name }) => name === "lin-report"),
    false,
  );
});

test("a rate limit in a linear session step that defers goes to its defer, not its recover, and the run goes on", async () => {
  const run = await uninterrupted(runDeferring, {
    session: { ok: false, error: RATE_LIMIT_ERROR },
  });
  assert.deepEqual(run.end, { kind: "saved", stage: "spec" });
  const { plan } = run.saved;
  assert.equal(plan, "deferred");
  assert.ok(run.calls.some(({ name }) => name === "lin-report"));
});

test("any other failure in a linear session step that defers still goes to its recover", async () => {
  const run = await uninterrupted(runDeferring, {
    session: { ok: false, error: "the model returned nothing" },
  });
  assert.deepEqual(run.end, { kind: "saved", stage: "spec" });
  const { plan } = run.saved;
  assert.equal(plan, "recovered");
});

test("a rate-limited run saves the counts it took back at their values when it began", async () => {
  // The first session replies and verify fails, counting a try, which is
  // saved before the second session, which hits the rate limit.
  const run = await uninterrupted("machine", {
    verify: (tries) => (tries === 0 && "fail") || "pass",
    session: inTurn([REPLIED, { ok: false, error: RATE_LIMIT_ERROR }]),
  });
  assert.deepEqual(run.end, HELD);
  assert.equal(sessions(run.calls), 2);
  assert.ok(
    run.calls.some(
      (call) =>
        call.kind === "save" &&
        call.state !== undefined &&
        triesOf(call.state) === 1,
    ),
  );
  assert.equal(triesOf(run.saved), 0);
});

test("any other session failure still takes the state's failed edge, and a second one stops", async () => {
  const run = await uninterrupted(runTakesFailure, {
    session: { ok: false, error: "the session broke" },
    ops: { stop },
  });
  assert.deepEqual(run.end, { kind: "stopped", code: "limit" });
  assert.equal(sessions(run.calls), 2);
  assert.equal(stops(run.calls), 1);
});

test("a rate-limited run followed by a run whose session replies leaves the retry unused", async () => {
  gh.reply([]);
  const place = world({
    session: inTurn([{ ok: false, error: RATE_LIMIT_ERROR }]),
    ops: { stop },
  });
  const first = await runToy(runTakesFailure, place, place.effects().effects);
  assert.deepEqual(first, HELD);
  const second = await runToy(runTakesFailure, place, place.effects().effects);
  assert.deepEqual(second, { kind: "saved", stage: "merge" });
  assert.equal(sessions(place.calls), 2);
  assert.equal(triesOf(place.store.saved), 0);
  assert.equal(stops(place.calls), 0);
});
