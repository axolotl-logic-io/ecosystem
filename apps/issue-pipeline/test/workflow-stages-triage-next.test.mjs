// Triage's step machine (src/workflow/stages/triage.ts), driven directly with
// recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin the prompt and each decision's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/triage.ts";
import {
  CTX,
  contextWith,
  expectedTask,
  REJECTED,
  replyOf,
  SIGNATURE,
  SPLIT_ALLOWED,
  SPLIT_FORBIDDEN,
  STAMP,
  SUB_ISSUES,
  sessionLaunch,
  stateWith,
} from "./workflow-triage-test-kit.mjs";

const TRIAGE_TOKENS = 50_000;
const PR = 42;
const PLAN_LIMIT = 4000;
// An issue budget smaller than one triage session.
const SMALL_BUDGET = 40_000;

// Triage's step after its session ends with `result`.
function afterSession(result, fields = {}) {
  const begun = next(stateWith(fields), CTX, []);
  return next(begun.state, CTX, [
    { kind: "child", error: null, by: SIGNATURE, ...result },
  ]);
}

// Triage's step after its session replies with `output`.
function decided(output, fields = {}) {
  return afterSession({ ok: true, structuredOutput: output }, fields);
}

// The step after `step`'s one ops request gets `reply`.
function replied(step, reply) {
  return next(step.state, CTX, [{ kind: "op", reply }]);
}

test("the first call counts the run, charges it and launches the session", () => {
  const given = stateWith();
  const step = next(given, CTX, []);
  assert.deepEqual(step.launches, [sessionLaunch(expectedTask(SPLIT_ALLOWED))]);
  assert.equal(step.done, false);
  assert.equal(step.state.phase, "decide");
  assert.equal(step.state.st.triages, 1);
  assert.equal(step.state.st.allocated, TRIAGE_TOKENS);
  assert.deepEqual(step.state.st.sessions, ["triage"]);
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.deepEqual(given, stateWith());
});

test("a sub-issue's session is told it may not split", () => {
  const step = next(stateWith({ depth: 1 }), CTX, []);
  assert.deepEqual(step.launches, [
    sessionLaunch(expectedTask(SPLIT_FORBIDDEN)),
  ]);
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
  assert.deepEqual(step.launches, [
    {
      kind: "op",
      name: "startpr",
      op: "start-pr",
      payload: { number: 7, plan: "Change a.ts." },
    },
  ]);
  const opened = replied(step, { ok: true, pr: PR, headSha: "aaaaaaa" });
  assert.equal(opened.done, true);
  assert.deepEqual(
    [opened.state.st.pr, opened.state.st.headSha, opened.state.st.implemented],
    [PR, "aaaaaaa", false],
  );
  assert.equal(opened.state.st.log.at(-1), `${STAMP} opened draft PR #42`);
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
    step.state.st.log.at(-1),
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
  assert.deepEqual(step.stop, { reason: REJECTED, detail: "A debate." });
});

test("a large issue at depth 0 is split, and closed for the sweep", () => {
  const split = replyOf({
    decision: "split",
    reason: "Big.",
    subIssues: SUB_ISSUES,
  });
  const step = decided(split);
  assert.deepEqual(step.launches, [
    {
      kind: "op",
      name: "split",
      op: "split",
      payload: {
        number: 7,
        state: step.state.st,
        subIssues: SUB_ISSUES,
        by: SIGNATURE,
      },
    },
  ]);
  assert.deepEqual([step.state.closed, step.state.outcome], [true, "split"]);
  assert.equal(replied(step, { ok: true }).done, true);
  assert.equal(decided(split, { depth: 1 }).stop.reason, REJECTED);
});

test("questions are asked, and no questions read as a reject", () => {
  const questions = ["Which page?"];
  const step = decided(replyOf({ decision: "needs-info", questions }));
  assert.deepEqual(step.launches, [
    {
      kind: "op",
      name: "ask",
      op: "ask",
      payload: { number: 7, state: step.state.st, questions, by: SIGNATURE },
    },
  ]);
  assert.deepEqual(
    [step.state.closed, step.state.outcome],
    [true, "needs-info"],
  );
  assert.equal(
    decided(replyOf({ decision: "needs-info" })).stop.reason,
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
  });
  assert.equal(decided({ decision: "maybe" }).stop.reason, "triage failed");
});

test("a run past maxTriages stops without a launch", () => {
  const step = next(stateWith({ triages: 2 }), CTX, []);
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, {
    reason:
      "triage ran 2 times without reaching a decision the pipeline can act on",
    detail: null,
  });
  assert.equal(step.state.st.allocated, 0);
});

test("a session the issue's budget can't fit stops triage", () => {
  const step = next(stateWith(), contextWith(SMALL_BUDGET), []);
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, {
    reason: "issue token budget exhausted",
    detail: "Allocated 0 of 40000 tokens; the next step (triage) needs 50000.",
  });
});
