// Spec's step machine (src/workflow/stages/spec.ts), driven directly with
// recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin the prompt and each decision's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/spec.ts";
import {
  afterReply,
  afterSession,
  BUILD_CTX,
  buildState,
  contextWith,
  PATHS,
  SPEC,
  SPEC_BY,
  STAMP,
  specLaunch,
  specTask,
  TRIAGE_TOKENS,
} from "./workflow-build-test-kit.mjs";

const SPEC_TOKENS = 80_000;
const SPEC_LIMIT = 12_000;
// An issue budget with room for triage but not for a spec session.
const SMALL_BUDGET = 100_000;
const START_FROM = /start from/u;
const QUESTIONS = ["Which file holds the thing?"];

// Spec's step after its session ends with `result`.
function decided(result) {
  const begun = next(buildState("spec"), BUILD_CTX, []);
  return afterSession(next, begun, SPEC_BY, result);
}

// Spec's step after its session replies with `fields` over a ready spec.
function replied(fields) {
  const output = { decision: "ready", spec: SPEC, questions: [], ...fields };
  return decided({ ok: true, structuredOutput: output });
}

test("the first call charges the spec writer and launches its session", () => {
  const given = buildState("spec");
  const step = next(given, BUILD_CTX, []);
  assert.deepEqual(step.launches, [specLaunch(specTask())]);
  assert.equal(step.done, false);
  assert.equal(step.state.phase, "decide");
  assert.equal(step.state.st.allocated, TRIAGE_TOKENS + SPEC_TOKENS);
  assert.deepEqual(step.state.st.sessions, ["triage", "spec"]);
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.deepEqual(given, buildState("spec"));
});

test("without a wiki the task names no wiki start page", () => {
  const paths = { ...PATHS, wiki: null };
  const step = next(buildState("spec", {}, paths), BUILD_CTX, []);
  assert.deepEqual(step.launches, [specLaunch(specTask(paths))]);
  assert.doesNotMatch(step.launches[0].task, START_FROM);
});

test("a budget too small for the session stops", () => {
  const step = next(buildState("spec"), contextWith(SMALL_BUDGET), []);
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, {
    reason: "issue token budget exhausted",
    detail:
      "Allocated 50000 of 100000 tokens (issueTokenBudget); the next step (spec) needs 80000.",
    code: null,
  });
  assert.equal(step.state.st.allocated, TRIAGE_TOKENS);
});

test("a ready spec is kept, posted, and moves the issue to implement", () => {
  const long = `${SPEC}\n${"x".repeat(SPEC_LIMIT)}`;
  const step = replied({ spec: long });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "implement");
  assert.equal(step.state.st.spec, `${long.slice(0, SPEC_LIMIT)}…`);
  assert.deepEqual(step.state.st.log, [
    `${STAMP} charged spec 80000 to issueTokenBudget`,
    `${STAMP} spec: ready`,
  ]);
  assert.deepEqual(step.comments, [
    {
      by: SPEC_BY,
      body: `## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.\n\n${long}`,
      where: "issue",
    },
  ]);
});

test("questions close the issue and go back to triage with the spec so far", () => {
  const step = replied({ decision: "needs-info", questions: QUESTIONS });
  assert.equal(step.done, false);
  assert.equal(step.state.closed, true);
  assert.equal(step.state.outcome, "needs-info");
  assert.equal(step.state.phase, "follow-up");
  assert.deepEqual(step.comments, [
    { by: SPEC_BY, body: `## Spec so far\n\n${SPEC}`, where: "issue" },
  ]);
  const [launch] = step.launches;
  assert.deepEqual(launch, {
    kind: "op",
    name: "ask",
    op: "ask",
    payload: {
      number: 7,
      state: { ...step.state.st, stage: "triage" },
      questions: QUESTIONS,
      by: SPEC_BY,
    },
  });
  assert.equal(step.state.st.stage, "spec");
  assert.deepEqual(step.state.st.log, [
    `${STAMP} charged spec 80000 to issueTokenBudget`,
    `${STAMP} spec: needs-info`,
  ]);
});

test("posted questions finish the stage", () => {
  const asked = replied({ decision: "needs-info", questions: QUESTIONS });
  const step = afterReply(next, asked, { ok: true });
  assert.equal(step.done, true);
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.equal(step.state.outcome, "needs-info");
});

test("questions that fail to post abort the sweep", () => {
  const asked = replied({ decision: "needs-info", questions: QUESTIONS });
  assert.throws(
    () => afterReply(next, asked, { ok: false, error: "gh down" }),
    { message: "spec follow-up failed: gh down" },
  );
});

test("needs-info without questions reads as ready", () => {
  const step = replied({ decision: "needs-info" });
  assert.equal(step.state.st.stage, "implement");
  assert.equal(step.state.closed, false);
});

test("a failed session or a malformed reply stops", () => {
  const failed = decided({
    ok: false,
    structuredOutput: null,
    error: "timeout",
  });
  assert.deepEqual(failed.stop, {
    reason: "the spec writer failed",
    detail: "timeout",
    code: null,
  });
  const malformed = decided({ ok: true, structuredOutput: { decision: "ok" } });
  assert.deepEqual(malformed.stop, {
    reason: "the spec writer failed",
    detail: null,
    code: null,
  });
});

test("an unknown phase throws", () => {
  const state = { ...buildState("spec"), phase: "later" };
  assert.throws(() => next(state, BUILD_CTX, []), {
    message: "spec: unknown phase later",
  });
});
