// @ts-check
// A spec run that asks keeps the ask's questionsAt (#457): the spec writer
// asks as triage does, after its `asked` end's save and on the state that
// save wrote, so the issue is left at triage with the questions' time, no
// lease, the hand-off fields, its counts at 0 (#454) and its start heads.
// Before #457 the ask ran first, with no state, and the end's save, built
// from the run's earlier save, wrote over it: #419 was saved with
// `questionsAt: null`, and the usage-records comment read as an answer. On
// the role runner with fake checks and the kit's fake ops, whose `ask`
// writes as the real op does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runMachine } from "../src/job/runner.ts";
import { specWriterMachine } from "../src/roles/spec-writer/machine.ts";
import { uninterrupted } from "./runner-test-kit.mjs";
import {
  READINGS,
  replyOf,
  specContext,
  stepFrom,
} from "./spec-writer-role-test-kit.mjs";
import { ASKED_AT, SPEC_OPS, specState } from "./spec-writer-run-test-kit.mjs";

/** @import { Outcome } from "../src/job/run-step.ts" */
/** @import { Act, Call, OpFake, RoleRun, WorldOptions } from "./runner-test-kit.mjs" */

const START = { startSha: "s1", startWikiSha: "w1" };
const QUESTIONS = ["Why?"];
/** @type {Outcome} */
const NEEDS_INFO = {
  ok: true,
  name: "replied",
  reply: replyOf({ decision: "needs-info", questions: QUESTIONS }),
};
// The counts a restarted spec run had saved before it asked: one attempt and
// one continuation.
const TAKEN = { attempts: 1, continuations: 1 };

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

/** @type {Act} what a failed ask comes to */
const ASK_FAILED = { reply: { ok: false, error: "gh failed" } };

/** @type {Readonly<Record<string, OpFake>>} the role's checks, as on a fresh branch */
const CHECKS = {
  claim: () => answered("ok"),
  retry: () => answered("ok"),
  checkout: () => answered("ok", START),
  "check-reply": (_store, { reading }) => answered(kindOf(reading)),
  reset: (_store, { reading }) => answered(kindOf(reading)),
};

/** @type {RoleRun} the spec writer's machine on the fake checks */
function runSpec(entry, effects) {
  return runMachine(specWriterMachine, entry, effects);
}

/**
 * The fake `ask`, with each payload it is sent appended to `seen`.
 * @param {unknown[]} seen
 * @returns {OpFake}
 */
function seeing(seen) {
  return (store, payload) => {
    seen.push(payload);
    return SPEC_OPS.ask(store, payload);
  };
}

/**
 * A spec run whose session asks, from a claim with `TAKEN` counts saved.
 * @param {Readonly<Record<string, OpFake>>} [ops] fakes over the kit's
 */
function asking(ops = {}) {
  /** @type {WorldOptions} */
  const options = {
    start: () => specState({ checkpoints: { ...START, ...TAKEN } }),
    context: specContext(),
    session: () => NEEDS_INFO,
    ops: { ...SPEC_OPS, ...ops },
    checks: CHECKS,
  };
  return uninterrupted(runSpec, options);
}

/** @param {readonly Call[]} calls @returns {number} the index of the last save before the first `ask` */
function saveBeforeAsk(calls) {
  const ask = calls.findIndex(
    ({ kind, name }) => kind === "op" && name === "ask",
  );
  return calls.findLastIndex(
    ({ kind }, index) => kind === "save" && index < ask,
  );
}

test("a spec run that asks saves at triage with the questions' time, no lease, its counts at 0 and its start heads", async () => {
  const run = await asking();
  assert.deepEqual(run.end, { kind: "saved", stage: "triage" });
  assert.deepEqual(run.labels, ["agent:needs-info"]);
  const { stage, lease, questionsAt, checkpoints } = run.saved;
  assert.deepEqual(
    { stage, lease, questionsAt },
    { stage: "triage", lease: null, questionsAt: ASKED_AT },
  );
  assert.deepEqual(checkpoints, { ...START, attempts: 0, continuations: 0 });
});

test("the spec writer asks after its end's save, on the state that save wrote, and keeps every field of it", async () => {
  /** @type {unknown[]} */
  const seen = [];
  const run = await asking({ ask: seeing(seen) });
  const saved = run.calls[saveBeforeAsk(run.calls)];
  assert.ok(saved?.state !== undefined, "no save came before the ask");
  const { stage, lease } = saved.state;
  assert.deepEqual({ stage, lease }, { stage: "triage", lease: null });
  assert.equal(seen.length, 1);
  assert.partialDeepStrictEqual(seen, [
    { number: 7, questions: QUESTIONS, state: saved.state },
  ]);
  assert.deepEqual(run.saved, { ...saved.state, questionsAt: ASKED_AT });
});

test("a failed ask ends the spec run as a failed step, after the issue was saved at triage", async () => {
  const run = await asking({ ask: () => ASK_FAILED });
  assert.deepEqual(run.end, { kind: "stopped", code: "error" });
  assert.ok(saveBeforeAsk(run.calls) >= 0, "no save came before the ask");
  assert.equal(run.saved.stage, "triage");
  assert.deepEqual(run.labels, []);
});

test("a needs-info reset ends the run at `asked`, which saves at triage and asks after", () => {
  const fields = { ...TAKEN, ...START, reply: READINGS["needs-info"] };
  const step = stepFrom("reset", "needs-info", null, fields);
  assert.equal(step.state.at, "asked");
  assert.partialDeepStrictEqual(step.effect, {
    kind: "end",
    end: {
      kind: "saved",
      stage: "triage",
      after: { op: "ask", payload: { number: 7, questions: QUESTIONS } },
    },
  });
});
