// @ts-check
// The spec writer killed anywhere (#334): a run killed before or after any
// effect call and started again ends as the uninterrupted run does, with at
// most one `## Spec` comment, no second draft PR or split, and resets only to
// the start heads the first checkout saved. The checks are fakes that keep
// the remote's heads and the comments in the store: once a session has run,
// a fresh checkout would find the branch it pushed, not the start heads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { runMachine } from "../src/job/runner.ts";
import { specWriterMachine } from "../src/roles/spec-writer/machine.ts";
import { killAt, uninterrupted } from "./runner-test-kit.mjs";
import { part, replyOf, specContext } from "./spec-writer-role-test-kit.mjs";
import {
  countOf,
  PR,
  restarts,
  SPEC_OPS,
  specPosts,
  specState,
} from "./spec-writer-run-test-kit.mjs";

/** @import { Act, Kill, OpFake, RoleRun, WorldOptions } from "./runner-test-kit.mjs" */

/** @type {readonly ("before" | "after")[]} */
const KILL_POINTS = ["before", "after"];
const FIRST_HEADS = "reset:s1:w1";
// The sub-issues a split opens.
const SUB_ISSUES = 2;

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
 * The check fakes; each reset made is appended to `resets`.
 * @param {string[]} resets
 * @returns {Readonly<Record<string, OpFake>>}
 */
function checksOf(resets) {
  return {
    claim: () => answered("ok"),
    retry: () => answered("ok"),
    checkout: (store) => {
      if (store.markers.has("pushed")) {
        return answered("ok", { startSha: "s2", startWikiSha: "w2" });
      }
      return answered("ok", { startSha: "s1", startWikiSha: "w1" });
    },
    "check-reply": (store, { reading }) => ({
      write: () => store.markers.add("pushed"),
      reply: { ok: true, name: kindOf(reading), reply: null },
    }),
    "spec-tests-check": () => answered("pass", { sha: "t1" }),
    "confirm-no-work": () => answered("pass"),
    reset: (_store, { startSha, startWikiSha, reading }) => ({
      write: () => {
        resets.push(`reset:${String(startSha)}:${String(startWikiSha)}`);
      },
      reply: { ok: true, name: kindOf(reading), reply: null },
    }),
    "publish-spec": (store, { spec }) => {
      const comments = [{ number: 7, key: "spec", body: "## Spec\n\nS" }];
      const posted = SPEC_OPS.post(store, { comments });
      return { ...posted, ...answered("code", { spec }) };
    },
    "close-old-pr": () => answered("ok"),
  };
}

/** @type {RoleRun} */
function runSpec(entry, effects) {
  return runMachine(specWriterMachine, entry, effects);
}

/** @param {Record<string, unknown>} fields @param {string[]} [resets] @returns {WorldOptions} */
function worldOf(fields, resets = []) {
  return {
    start: () => specState(),
    context: specContext(),
    session: () => ({ ok: true, name: "replied", reply: replyOf(fields) }),
    ops: SPEC_OPS,
    checks: checksOf(resets),
    restarts,
  };
}

/** @type {Record<string, unknown>} */
const READY = {};
const READY_RUN = await ref(READY);
const ASK = { decision: "needs-info", questions: ["?"] };
const SPLIT = { decision: "split", subIssues: [part("A"), part("B")] };
const NO_WORK = { decision: "no-work" };

// Each decision's uninterrupted run, made before any test is defined, so no
// test's fake gh calls come between.
const SCENARIOS = [
  { name: "ready", fields: READY, reference: READY_RUN },
  { name: "needs-info", fields: ASK, reference: await ref(ASK) },
  { name: "split", fields: SPLIT, reference: await ref(SPLIT) },
  { name: "no-work", fields: NO_WORK, reference: await ref(NO_WORK) },
];

/** @param {Record<string, unknown>} fields */
function ref(fields) {
  return uninterrupted(runSpec, worldOf(fields));
}

/** @param {{ writes: string[][] }} run */
function effectsOf(run) {
  return {
    posts: specPosts(run.writes),
    prs: countOf(run.writes, "pr", "create"),
    subIssues: countOf(run.writes, "issue", "create"),
  };
}

test("an uninterrupted ready run saves its draft PR and spec at implement", () => {
  const { stage, pr, headSha, implemented, specTestsSha, specWritesTests } =
    READY_RUN.saved;
  assert.deepEqual(
    { stage, pr, headSha, implemented, specTestsSha, specWritesTests },
    {
      stage: "implement",
      pr: PR,
      headSha: "h1",
      implemented: false,
      specTestsSha: "t1",
      specWritesTests: true,
    },
  );
});

for (const { name, fields, reference } of SCENARIOS) {
  test(`an uninterrupted ${name} run posts its spec once, opens at most one PR and splits once`, () => {
    const made = effectsOf(reference);
    assert.equal(made.posts, Number(name === "ready"));
    assert.equal(made.prs, Number(name === "ready"));
    assert.equal(made.subIssues, Number(name === "split") * SUB_ISSUES);
  });
  for (let k = 1; k <= reference.calls.length; k += 1) {
    for (const when of KILL_POINTS) {
      test(`a ${name} spec writer killed ${when} call ${k} ends as an uninterrupted one`, async () => {
        /** @type {Kill} */
        const kill = { k, when };
        /** @type {string[]} */
        const resets = [];
        const run = await killAt(runSpec, kill, worldOf(fields, resets));
        const end =
          run.end === "killed" || isDeepStrictEqual(run.end, reference.end);
        assert.ok(end, JSON.stringify(run.end));
        assert.equal(run.saved.stage, reference.saved.stage);
        assert.deepEqual(effectsOf(run), effectsOf(reference));
        for (const reset of resets) {
          assert.equal(reset, FIRST_HEADS);
        }
      });
    }
  }
}
