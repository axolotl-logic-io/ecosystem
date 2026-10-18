// @ts-check
// The role runner's `sessions` effect (#421): one usage entry per session,
// in the effect's order, each with its own launch key; every session's
// outcome in the reply, a failed one dropping no other's; and a transient
// or network failure of any one of them holding the run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runToy, world } from "./runner-test-kit.mjs";
import { TOY_STATES, toyMachine, WORK } from "./runner-toys.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { SessionEffect } from "../src/roles/machine.ts" */
/** @import { WorldOptions } from "./runner-test-kit.mjs" */

const NAMES = ["lens-a", "lens-b", "lens-c"];
// A DNS failure, a network error but no transient provider error.
const NETWORK_ERROR = "Could not resolve host: api.anthropic.com";
const PLAIN_ERROR = "the session ended with no output";

/** @type {readonly SessionEffect[]} */
const SESSIONS = NAMES.map((name) => ({ ...WORK, name }));

// The toy machine with its `work` state running the three sessions as one
// effect, and saving the effect's reply as its plan.
const machine = toyMachine({
  states: {
    ...TOY_STATES,
    work: {
      kind: "session",
      effect: () => ({ kind: "sessions", sessions: SESSIONS }),
      on: {
        replied: {
          to: "verify",
          apply: (data, reply) => ({ ...data, plan: JSON.stringify(reply) }),
        },
      },
    },
  },
});

/** @param {string} name @param {string} error @returns {(effect: SessionEffect) => Outcome} */
function failing(name, error) {
  return (effect) => {
    if (effect.name === name) {
      return { ok: false, error };
    }
    return { ok: true, name: "replied", reply: { from: effect.name } };
  };
}

/** @param {WorldOptions} options */
async function runSessions(options) {
  const place = world(options);
  const end = await runToy("machine", place, place.effects().effects, machine);
  const sessions = place.usages.flatMap((entry) => {
    if (entry.kind !== "session") {
      return [];
    }
    return [{ name: entry.name, key: entry.key, ended: entry.ended }];
  });
  const { plan } = place.store.saved;
  return { end, sessions, plan };
}

test("a sessions effect appends one usage entry per session, in the effect's order, each with its own key", async () => {
  const run = await runSessions({ session: failing("none", PLAIN_ERROR) });
  assert.deepEqual(run.end, { kind: "saved", stage: "merge" });
  assert.deepEqual(
    run.sessions,
    NAMES.map((name) => ({ name, key: `i7-${name}-1`, ended: "reply" })),
  );
});

test("a session's plain failure drops no other session's reply", async () => {
  const run = await runSessions({ session: failing("lens-b", PLAIN_ERROR) });
  assert.deepEqual(run.end, { kind: "saved", stage: "merge" });
  assert.deepEqual(JSON.parse(String(run.plan)), [
    { name: "lens-a", outcome: { ok: true, reply: { from: "lens-a" } } },
    { name: "lens-b", outcome: { ok: false, error: PLAIN_ERROR } },
    { name: "lens-c", outcome: { ok: true, reply: { from: "lens-c" } } },
  ]);
  assert.deepEqual(
    run.sessions.map(({ ended }) => ended),
    ["reply", "error", "reply"],
  );
});

test("a network failure of one session holds the run, with every session's usage entry kept", async () => {
  const run = await runSessions({ session: failing("lens-b", NETWORK_ERROR) });
  assert.deepEqual(run.end, { kind: "held" });
  assert.deepEqual(
    run.sessions.map(({ name }) => name),
    NAMES,
  );
  assert.equal(run.plan, null, "no reply reached the state");
});
