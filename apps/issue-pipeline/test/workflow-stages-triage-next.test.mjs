// @ts-check
// Triage's step machine (src/workflow/stages/triage.ts), driven directly with
// recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin the prompt and each decision's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/triage.ts";
import {
  asSessions,
  opsRequests,
  sessions,
} from "./stage-outcome-test-kit.mjs";
import {
  CTX,
  expectedTask,
  PATHS,
  REJECTED,
  replyOf,
  SIGNATURE,
  SPLIT_ALLOWED,
  SPLIT_FORBIDDEN,
  STAMP,
  sessionLaunch,
  stateWith,
} from "./workflow-triage-test-kit.mjs";

/** @import { ChildResult, OpResult, Step } from "../src/workflow/stages/types.ts" */
/** @typedef {Parameters<typeof stateWith>[0]} Fields */
/** @typedef {Pick<ChildResult, "ok" | "structuredOutput"> & Partial<Pick<ChildResult, "error">>} Ended */

const PR = 42;
const PLAN_LIMIT = 4000;

// Triage's step after its session ends with `result`.
/** @param {Ended} result @param {Fields} [fields] @returns {Step} */
function afterSession(result, fields = {}) {
  const begun = next(stateWith(fields), CTX, []);
  return next(begun.state, CTX, [
    { kind: "child", error: null, by: SIGNATURE, ...result },
  ]);
}

// Triage's step after its session replies with `output`.
/** @param {unknown} output @param {Fields} [fields] @returns {Step} */
function decided(output, fields = {}) {
  return afterSession({ ok: true, structuredOutput: output }, fields);
}

// The step after `step`'s one ops request gets `reply`.
/** @param {Step} step @param {OpResult["reply"]} reply @returns {Step} */
function replied(step, reply) {
  return next(step.state, CTX, [{ kind: "op", reply }]);
}

// The triage session that works on `task`.
/** @param {string} task @returns {ReturnType<typeof asSessions>} */
function triager(task) {
  return asSessions([sessionLaunch(task)]);
}

test("the first call counts the run, charges it and launches the session", () => {
  const given = stateWith();
  const step = next(given, CTX, []);
  assert.deepEqual(sessions(step), triager(expectedTask(SPLIT_ALLOWED)));
  assert.equal(step.done, false);
  assert.equal(step.state.phase, "decide");
  assert.equal(step.state.st.triages, 1);
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.deepEqual(given, stateWith());
});

test("a sub-issue's session is told it may not split", () => {
  const step = next(stateWith({ depth: 1 }), CTX, []);
  assert.deepEqual(sessions(step), triager(expectedTask(SPLIT_FORBIDDEN)));
});

test("the session is told to read an earlier implementer's handoff (#283)", () => {
  const [session] = sessions(next(stateWith(), CTX, []));
  assert.ok(session?.task.includes(PATHS.handoffFile));
});

test("a ready issue moves to spec, is taken, and opens its draft PR", () => {
  const step = decided(replyOf({ reason: "Small.", plan: "Change a.ts." }));
  assert.equal(step.state.st.stage, "spec");
  assert.equal(step.state.st.plan, "Change a.ts.");
  assert.deepEqual(step.state.st.log, [`${STAMP} triage: ready - Small.`]);
  assert.deepEqual(step.comments, [
    {
      by: SIGNATURE,
      body: "Taking this issue. Small. A spec follows.",
      where: "issue",
    },
  ]);
  assert.deepEqual(opsRequests(step), [
    { op: "start-pr", payload: { number: 7, plan: "Change a.ts." } },
  ]);
  const opened = replied(step, { ok: true, pr: PR, headSha: "aaaaaaa" });
  assert.equal(opened.done, true);
  assert.deepEqual(
    [opened.state.st.pr, opened.state.st.headSha, opened.state.st.implemented],
    [PR, "aaaaaaa", false],
  );
  assert.equal(opened.state.st.log?.at(-1), `${STAMP} opened draft PR #42`);
  assert.deepEqual([opened.comments, opened.stop], [[], null]);
});

test("a ready issue's plan is clipped to 4000 characters", () => {
  const step = decided(replyOf({ plan: "x".repeat(PLAN_LIMIT + 1) }));
  assert.equal(step.state.st.plan, `${"x".repeat(PLAN_LIMIT)}…`);
});

test("a ready issue with a PR is done with no launch", () => {
  const step = decided(replyOf({ reason: "Small." }), { pr: PR });
  assert.equal(step.done, true);
  assert.equal(Object.hasOwn(step, "launches"), false);
  assert.equal(step.comments.length, 1);
  assert.equal(step.state.st.stage, "spec");
});

test("a failed draft PR is only logged", () => {
  const step = replied(decided(replyOf({})), { ok: false, error: "gh failed" });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.pr, null);
  assert.equal(
    step.state.st.log?.at(-1),
    `${STAMP} could not open the draft PR yet: gh failed`,
  );
});

test("a rejected issue gets the reason, then a stop", () => {
  const step = decided(replyOf({ decision: "reject", reason: "A debate." }));
  assert.equal(step.done, true);
  assert.deepEqual(step.comments, [
    {
      by: SIGNATURE,
      body: "This issue isn't one the pipeline should take on: A debate.",
      where: "issue",
    },
  ]);
  assert.deepEqual(step.stop, {
    reason: REJECTED,
    detail: "A debate.",
    code: null,
  });
});

test("a large issue at depth 0 goes on to the spec with its split suggested", () => {
  const split = replyOf({
    decision: "split",
    reason: "Big.",
    plan: "Cut a.ts from b.ts.",
  });
  const step = decided(split);
  assert.equal(step.done, true);
  assert.equal(Object.hasOwn(step, "launches"), false);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "spec");
  assert.equal(step.state.st.splitSuggested, "Big.");
  assert.equal(step.state.st.plan, "Cut a.ts from b.ts.");
  assert.equal(
    step.state.st.log?.at(-1),
    `${STAMP} triage: split-suggested - Big.`,
  );
  assert.deepEqual(step.comments, [
    {
      by: SIGNATURE,
      body: "Taking this issue. Big. A spec follows, which may split it.",
      where: "issue",
    },
  ]);
});

test("a sub-issue's split stops with the triage-rejected reason and the reject comment", () => {
  const split = replyOf({ decision: "split", reason: "Big.", plan: "Cut." });
  const step = decided(split, { depth: 1 });
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, { reason: REJECTED, detail: "Big.", code: null });
  assert.deepEqual(step.comments, [
    {
      by: SIGNATURE,
      body: "This issue isn't one the pipeline should take on: Big.",
      where: "issue",
    },
  ]);
});

test("a ready triage clears an earlier suggested split", () => {
  const step = decided(replyOf({ reason: "Small." }), {
    splitSuggested: "Big.",
  });
  assert.equal(step.state.st.splitSuggested, null);
  const fresh = decided(replyOf({ reason: "Small." }));
  assert.equal(Object.hasOwn(fresh.state.st, "splitSuggested"), false);
});

test("questions are asked, and no questions read as a reject", () => {
  const questions = ["Which page?"];
  const step = decided(replyOf({ decision: "needs-info", questions }));
  assert.deepEqual(opsRequests(step), [
    {
      op: "ask",
      payload: { number: 7, state: step.state.st, questions, by: SIGNATURE },
    },
  ]);
  assert.deepEqual(
    [step.state.closed, step.state.outcome],
    [true, "needs-info"],
  );
  assert.equal(
    decided(replyOf({ decision: "needs-info" })).stop?.reason,
    REJECTED,
  );
});

test("a failed follow-up aborts the sweep", () => {
  const step = decided(
    replyOf({ decision: "needs-info", questions: ["Why?"] }),
  );
  assert.throws(() => replied(step, { ok: false, error: "gh failed" }), {
    message: "triage follow-up failed: gh failed",
  });
});

test("a session with no structured output stops triage", () => {
  const failed = afterSession({
    ok: false,
    structuredOutput: null,
    error: "timed out",
  });
  assert.deepEqual(failed.stop, {
    reason: "triage failed",
    detail: "timed out",
    code: null,
  });
  assert.equal(decided({ decision: "maybe" }).stop?.reason, "triage failed");
});

test("a run past maxTriages stops without a launch", () => {
  const step = next(stateWith({ triages: 2 }), CTX, []);
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, {
    reason:
      "triage ran 2 times without reaching a decision the pipeline can act on",
    detail: null,
    code: null,
  });
});
