// @ts-check
// A return to triage starts the spec writer's budget again (#454): a spec
// run that ends by asking saves its attempt and continuation counts at 0,
// keeping its start heads, so the spec run after triage passes the issue
// back gets its full budget. Before #454 #419's asked run saved
// `attempts: 2`, and the next spec job stopped at `failed-twice` with no
// session. Within one spec stage the counts still hold. On the role runner
// with fake checks and ops, over one store, as the job claims it in turn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runMachine } from "../src/job/runner.ts";
import { roleOf } from "../src/roles/registry.ts";
import { specWriterMachine } from "../src/roles/spec-writer/machine.ts";
import { JOB_CONFIG } from "./role-context-fixtures.mjs";
import { gh, runToy, uninterrupted, world } from "./runner-test-kit.mjs";
import {
  replyOf,
  specContext,
  stepFrom,
} from "./spec-writer-role-test-kit.mjs";
import { SPEC_OPS, specState } from "./spec-writer-run-test-kit.mjs";
import { replyOf as triageReplyOf } from "./triage-role-test-kit.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { SessionEffect } from "../src/roles/machine.ts" */
/** @import { Act, OpFake, RoleRun, WorldOptions } from "./runner-test-kit.mjs" */
/** @import { State } from "../src/state.ts" */

const FAILED_TWICE = "the spec writer failed twice";
const START = { startSha: "s1", startWikiSha: "w1" };
// The output of #419's failed commit check.
const REVERTED_FAILS = "reverted-fails: the tests fail on the base too";
/** @type {Outcome} */
const READY = { ok: true, name: "replied", reply: replyOf() };
/** @type {Outcome} */
const NEEDS_INFO = {
  ok: true,
  name: "replied",
  reply: replyOf({ decision: "needs-info", questions: ["Why?"] }),
};
/** @type {Outcome} */
const HANDOFF = {
  ok: true,
  name: "replied",
  reply: { status: "handoff", summary: "Half done." },
};
/** @type {Outcome} */
const BROKE = { ok: false, error: "the session broke" };
/** @type {Outcome} */
const TRIAGE_READY = {
  ok: true,
  name: "replied",
  reply: triageReplyOf({ decision: "ready", reason: "Ok.", plan: "p" }),
};

/** @param {string} name @param {unknown} [reply] @returns {Act} */
function answered(name, reply = null) {
  return { reply: { ok: true, name, reply } };
}

/** @param {unknown} reading @returns {string} the kind of a reading */
function kindOf(reading) {
  if (typeof reading === "object" && reading !== null && "kind" in reading) {
    return String(reading.kind);
  }
  return "bad";
}

/**
 * The role's checks, answering as on a fresh branch; the commit check fails
 * the first time, as #419's did, and passes after.
 * @returns {Readonly<Record<string, OpFake>>}
 */
function checks() {
  let commitChecks = 0;
  return {
    claim: () => answered("ok"),
    retry: () => answered("ok"),
    checkout: () => answered("ok", START),
    "spec-commits": () =>
      answered("ok", {
        committed: { tests: [], stubs: [], wiki: [], draft: true },
      }),
    "check-reply": (_store, { reading }) => answered(kindOf(reading)),
    reset: (_store, { reading }) => answered(kindOf(reading)),
    "spec-tests-check": () => {
      commitChecks += 1;
      if (commitChecks === 1) {
        return answered("fail", REVERTED_FAILS);
      }
      return answered("pass", { sha: "t1" });
    },
    "publish-spec": (_store, { spec }) => answered("code", { spec }),
    "close-old-pr": () => answered("ok"),
  };
}

// The spec writer's machine on the fake checks (the registry's run would
// carry out its real ones).
/** @type {RoleRun} */
function runSpec(entry, effects) {
  return runMachine(specWriterMachine, entry, effects);
}

/** @type {RoleRun} triage as the registry runs it */
function runTriage(entry, effects) {
  const role = roleOf("triage");
  if (role === undefined) {
    throw new Error("triage isn't registered");
  }
  return role.run(entry, effects, JOB_CONFIG);
}

/**
 * A world whose spec sessions come to `outcomes` in turn, then reply ready,
 * and whose triage sessions find the issue ready; `attempts` collects each
 * spec session's attempt.
 * @param {readonly Outcome[]} outcomes
 * @param {State} start
 * @param {number[]} attempts
 * @returns {WorldOptions}
 */
function worldOf(outcomes, start, attempts) {
  let made = 0;
  /** @param {SessionEffect} effect @returns {Outcome} */
  function session(effect) {
    if (effect.name !== "spec") {
      return TRIAGE_READY;
    }
    attempts.push(effect.attempt);
    const outcome = outcomes[made] ?? READY;
    made += 1;
    return outcome;
  }
  return {
    start: () => start,
    context: specContext(),
    session,
    ops: SPEC_OPS,
    checks: checks(),
  };
}

/** @param {State} saved @returns {Record<string, unknown>} its checkpoints */
function checkpointsIn(saved) {
  return { ...saved.checkpoints };
}

/** @param {readonly { kind: string, name: string }[]} calls @param {string} kind @param {string} name @returns {number} */
function countOf(calls, kind, name) {
  return calls.filter((call) => call.kind === kind && call.name === name)
    .length;
}

// #419's run: a handoff's continuation, a ready reply whose commit check
// fails, and a retry that asks.
const ASKING = [HANDOFF, READY, NEEDS_INFO];

test("the asked end takes the spec writer's counts back to 0 and keeps its start heads", () => {
  const counts = { attempts: 2, continuations: 1 };
  const step = stepFrom("ask", "ok", null, { ...counts, ...START });
  assert.equal(step.state.at, "asked");
  const { attempts, continuations, startSha, startWikiSha } = step.state.data;
  assert.deepEqual(
    { attempts, continuations, startSha, startWikiSha },
    { attempts: 0, continuations: 0, ...START },
  );
  assert.deepEqual(step.effect, {
    kind: "end",
    end: { kind: "saved", stage: "triage" },
  });
});

test("a spec run that asks after a failed check and a continuation saves at triage with its counts at 0 and its start heads kept", async () => {
  /** @type {number[]} */
  const attempts = [];
  const run = await uninterrupted(
    runSpec,
    worldOf(ASKING, specState(), attempts),
  );
  assert.deepEqual(run.end, { kind: "saved", stage: "triage" });
  assert.deepEqual(attempts, [1, 1, 2]);
  assert.deepEqual(checkpointsIn(run.saved), {
    ...START,
    attempts: 0,
    continuations: 0,
  });
});

test("after an asked spec run and a triage that passes, the next spec run's first session is attempt 1 and nothing stops", async () => {
  gh.reply([]);
  /** @type {number[]} */
  const attempts = [];
  const place = world(worldOf(ASKING, specState(), attempts));
  const spec = await runToy(runSpec, place, place.effects().effects);
  assert.deepEqual(spec, { kind: "saved", stage: "triage" });
  place.store.saved = { ...place.store.saved, lease: { holder: "job" } };
  const triage = await runToy(runTriage, place, place.effects().effects);
  assert.deepEqual(triage, { kind: "saved", stage: "spec" });
  place.store.saved = { ...place.store.saved, lease: { holder: "job" } };
  const again = place.effects();
  const respec = await runToy(runSpec, place, again.effects);
  assert.deepEqual(respec, { kind: "saved", stage: "implement" });
  assert.deepEqual(attempts.slice(ASKING.length), [1]);
  assert.equal(countOf(again.made, "session", "spec"), 1);
  assert.equal(countOf(again.made, "op", "stop"), 0);
  assert.ok(!place.store.labels.has("agent:stopped-error"));
  const { stopReason } = place.store.saved;
  assert.equal(stopReason, undefined);
});

test("within one spec stage the counts hold: a restart with one attempt saved runs attempt 2, and its failure stops the issue as failed twice", async () => {
  /** @type {number[]} */
  const attempts = [];
  const saved = specState({
    checkpoints: { ...START, attempts: 1, continuations: 0 },
  });
  const run = await uninterrupted(
    runSpec,
    worldOf([BROKE, BROKE], saved, attempts),
  );
  assert.deepEqual(attempts, [2]);
  assert.deepEqual(run.end, { kind: "stopped", code: "error" });
  const { stopReason } = run.saved;
  assert.equal(stopReason, FAILED_TWICE);
  assert.deepEqual(run.labels, ["agent:stopped-error"]);
});
