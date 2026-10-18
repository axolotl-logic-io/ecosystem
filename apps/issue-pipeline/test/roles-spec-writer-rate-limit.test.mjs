// @ts-check
// The spec writer on the role runner defers on a transient provider error
// (#446, `rate-limit-defers`): its session state takes its own failures
// (`failed` → `retry`), but a rate limit, an overload or a transport error
// ends the run held as rate-limited, with no retry, no stop, the issue at
// spec and its attempt and continuation counts as the run began, and its
// start heads kept. Any other failure still uses the one retry, and a second
// one stops the issue as failed twice. Before #446 one account rate limit
// stopped #419 and #420 at spec with "the spec writer failed twice".
import assert from "node:assert/strict";
import { test } from "node:test";
import { runMachine } from "../src/job/runner.ts";
import { specWriterMachine } from "../src/roles/spec-writer/machine.ts";
import { gh, runToy, uninterrupted, world } from "./runner-test-kit.mjs";
import { replyOf, specContext } from "./spec-writer-role-test-kit.mjs";
import { SPEC_OPS, specState } from "./spec-writer-run-test-kit.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { Act, Call, OpFake, RoleRun, WorldOptions } from "./runner-test-kit.mjs" */
/** @import { State } from "../src/state.ts" */

const FAILED_TWICE = "the spec writer failed twice";
// The error each spec session of #419 and #420 failed with.
const RATE_LIMIT_ERROR =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';
const CONNECTION_RESET = "request to the provider failed: read ECONNRESET";
const TRANSIENT = [
  { name: "rate limit", error: RATE_LIMIT_ERROR },
  { name: "transport error", error: CONNECTION_RESET },
];
const HELD = { kind: "held", rateLimited: true };
/** @type {Outcome} */
const READY = { ok: true, name: "replied", reply: replyOf() };
/** @type {Outcome} */
const HANDOFF = {
  ok: true,
  name: "replied",
  reply: { status: "handoff", summary: "Half done." },
};

/** @param {string} error @returns {Outcome} a session that failed with `error` */
function failing(error) {
  return { ok: false, error };
}

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

/** @type {Readonly<Record<string, OpFake>>} the role's checks, answering as on a fresh branch */
const CHECKS = {
  claim: () => answered("ok"),
  retry: () => answered("ok"),
  checkout: () => answered("ok", { startSha: "s1", startWikiSha: "w1" }),
  "spec-commits": () =>
    answered("ok", {
      committed: {
        tests: ["test/a.test.mjs"],
        stubs: [],
        wiki: [],
        draft: true,
      },
    }),
  "check-reply": (_store, { reading }) => answered(kindOf(reading)),
  "spec-tests-check": () => answered("pass", { sha: "t1" }),
  "publish-spec": (_store, { spec }) => answered("code", { spec }),
  "close-old-pr": () => answered("ok"),
};

/** @type {RoleRun} */
function runSpec(entry, effects) {
  return runMachine(specWriterMachine, entry, effects);
}

/**
 * Sessions that come to `outcomes` in turn, then reply ready.
 * @param {readonly Outcome[]} outcomes
 * @returns {() => Outcome}
 */
function inTurn(outcomes) {
  let made = 0;
  return () => {
    const outcome = outcomes[made] ?? READY;
    made += 1;
    return outcome;
  };
}

/** @param {readonly Outcome[]} outcomes @returns {WorldOptions} issue #7 at spec, its sessions coming to `outcomes` */
function worldOf(outcomes) {
  return {
    start: () => specState(),
    context: specContext(),
    session: inTurn(outcomes),
    ops: SPEC_OPS,
    checks: CHECKS,
  };
}

/** @param {readonly Call[]} calls @param {string} kind @param {string} name @returns {number} */
function countOf(calls, kind, name) {
  return calls.filter((call) => call.kind === kind && call.name === name)
    .length;
}

/** @param {State} saved @param {string} count @returns {unknown} a saved count, 0 when missing */
function countIn(saved, count) {
  return new Map(Object.entries(saved.checkpoints ?? {})).get(count) ?? 0;
}

for (const { name, error } of TRANSIENT) {
  test(`a spec writer session that fails on a ${name} ends held as rate-limited, with no retry, no stop and no attempt counted`, async () => {
    const run = await uninterrupted(runSpec, worldOf([failing(error)]));
    assert.deepEqual(run.end, HELD);
    assert.equal(countOf(run.calls, "session", "spec"), 1);
    assert.equal(countOf(run.calls, "check", "retry"), 0);
    assert.equal(countOf(run.calls, "op", "stop"), 0);
    assert.deepEqual(run.labels, []);
    assert.deepEqual(run.writes, []);
    const { stage, lease } = run.saved;
    assert.deepEqual({ stage, lease }, { stage: "spec", lease: null });
    assert.equal(countIn(run.saved, "attempts"), 0);
    assert.equal(countIn(run.saved, "continuations"), 0);
    assert.equal(countIn(run.saved, "startSha"), "s1");
  });
}

test("a continuation session that hits a rate limit puts back the continuation it took", async () => {
  const outcomes = [HANDOFF, failing(RATE_LIMIT_ERROR)];
  const run = await uninterrupted(runSpec, worldOf(outcomes));
  assert.deepEqual(run.end, HELD);
  assert.equal(countOf(run.calls, "session", "spec"), 2);
  assert.equal(countIn(run.saved, "continuations"), 0);
  assert.equal(countIn(run.saved, "attempts"), 0);
  assert.equal(run.saved.stage, "spec");
});

test("any other session failure uses the one retry, and a second one stops the issue as failed twice", async () => {
  const failed = failing("the session broke");
  const run = await uninterrupted(runSpec, worldOf([failed, failed]));
  assert.deepEqual(run.end, { kind: "stopped", code: "error" });
  assert.equal(countOf(run.calls, "session", "spec"), 2);
  // Each failure records itself at retry; the second finds no attempt left.
  assert.equal(countOf(run.calls, "check", "retry"), 2);
  assert.equal(countOf(run.calls, "op", "stop"), 1);
  const { stopReason } = run.saved;
  assert.equal(stopReason, FAILED_TWICE);
  assert.deepEqual(run.labels, ["agent:stopped-error"]);
});

test("a rate-limited run, then a run whose session replies, leaves the retry unused", async () => {
  gh.reply([]);
  const place = world(worldOf([failing(RATE_LIMIT_ERROR)]));
  const first = await runToy(runSpec, place, place.effects().effects);
  assert.deepEqual(first, HELD);
  const second = await runToy(runSpec, place, place.effects().effects);
  assert.deepEqual(second, { kind: "saved", stage: "implement" });
  assert.equal(countOf(place.calls, "session", "spec"), 2);
  assert.equal(countOf(place.calls, "check", "retry"), 0);
  assert.equal(countIn(place.store.saved, "attempts"), 1);
});
