// @ts-check
// Implement's step machine (src/workflow/stages/implement.ts), driven directly
// with recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin the prompt, the continuation and each status's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/implement.ts";
import { asSessions, sessions } from "./stage-outcome-test-kit.mjs";
import {
  afterSession,
  BUILD_CTX,
  buildState,
  contextWith,
  HANDOFF,
  IMPL_BY,
  implementLaunch,
  implementTask,
  PLAN,
  SPEC,
  STAMP,
  TRIAGE_TOKENS,
} from "./workflow-build-test-kit.mjs";

/** @import { StageState, Step } from "../src/workflow/stages/types.ts" */
/** @typedef {Readonly<Record<string, unknown>>} Reply */

const IMPL_TOKENS = 150_000;
const TITLE_LIMIT = 200;
// An issue budget with room for triage but not for an implementer session.
const SMALL_BUDGET = 150_000;
const HANDOFF_LINE = `A previous session ran out of room. Read its handoff first: ${HANDOFF}. Continue from the current branch state.`;
const CONTINUED =
  "This session ran out of room before finishing. A second implementer session continues from its handoff.";

// A spec clipped in the saved state, and where its full text is (#280).
const CLIPPED = "## Behaviour\n\n1. The clipped copy…";
const SPEC_FILE = "/w/runs/o__r/issue-7/spec.md";
const READ_WHOLE = /Read the whole spec there/u;

// The implementer's reply, with `fields` replacing a finished one's.
/** @param {Reply} fields @returns {Reply} */
function replyOf(fields) {
  return {
    status: "done",
    summary: "Did the thing.",
    prTitle: "Do the thing",
    prBody: "Does the thing, tested in src/a.test.ts.",
    testsAdded: ["src/a.test.ts"],
    ...fields,
  };
}

// Implement's step after a session from `state` replies with `fields`.
/** @param {StageState} state @param {Reply} fields @returns {Step} */
function replied(state, fields) {
  const begun = next(state, BUILD_CTX, []);
  const output = replyOf(fields);
  return afterSession(next, begun, IMPL_BY, {
    ok: true,
    structuredOutput: output,
  });
}

// The step's state as the sweep begins the stage again.
/** @param {Step} step @returns {Step} */
function begunAgain(step) {
  return next({ ...step.state, phase: "begin" }, BUILD_CTX, []);
}

// The implementer session that works on `task`, as a writer.
/** @param {string} task @returns {ReturnType<typeof asSessions>} */
function implementer(task) {
  return asSessions([implementLaunch(task)]);
}

test("a clipped spec reaches the implementer by its full text's path", () => {
  const given = buildState("implement", { spec: CLIPPED, specFile: SPEC_FILE });
  const [session] = sessions(next(given, BUILD_CTX, []));
  const task = session?.task ?? "";
  assert.ok(task.includes(SPEC_FILE));
  assert.match(task, READ_WHOLE);
  assert.ok(!task.includes(CLIPPED));
});

test("the first call charges the implementer and launches a writer from the spec", () => {
  const given = buildState("implement", { spec: SPEC });
  const step = next(given, BUILD_CTX, []);
  assert.deepEqual(
    sessions(step),
    implementer(implementTask(`Spec (also posted on the issue):\n${SPEC}`)),
  );
  assert.equal(sessions(step)[0]?.agent, "issue-pipeline-writer");
  assert.equal(step.state.phase, "decide");
  assert.equal(step.state.st.allocated, TRIAGE_TOKENS + IMPL_TOKENS);
  assert.deepEqual(step.state.st.sessions, ["triage", "implementer"]);
  assert.deepEqual(given, buildState("implement", { spec: SPEC }));
});

test("without a spec the session works from triage's plan", () => {
  const step = next(buildState("implement"), BUILD_CTX, []);
  assert.deepEqual(
    sessions(step),
    implementer(implementTask(`Triage plan:\n${PLAN}`)),
  );
});

test("a budget too small for the session stops", () => {
  const step = next(buildState("implement"), contextWith(SMALL_BUDGET), []);
  assert.equal(step.done, true);
  assert.equal(step.stop?.reason, "issue token budget exhausted");
});

test("a handoff, then a continuation, then done moves the issue to open-pr", () => {
  const first = replied(buildState("implement", { spec: SPEC }), {
    status: "handoff",
    summary: "Half done.",
  });
  assert.equal(first.done, true);
  assert.equal(first.stop, null);
  assert.equal(first.state.st.stage, "implement");
  assert.equal(first.state.st.continuations, 1);
  assert.deepEqual(first.comments, [
    { by: IMPL_BY, body: `${CONTINUED}\n\nHalf done.`, where: "issue" },
  ]);
  assert.deepEqual(first.state.st.log, [
    `${STAMP} charged implementer 150000 to issueTokenBudget`,
    `${STAMP} implement: handoff - Half done.`,
  ]);
  const again = begunAgain(first);
  assert.deepEqual(sessions(again), implementer(implementTask(HANDOFF_LINE)));
  const done = afterSession(next, again, IMPL_BY, {
    ok: true,
    structuredOutput: replyOf({ prTitle: "t".repeat(TITLE_LIMIT + 1) }),
  });
  assert.equal(done.done, true);
  assert.equal(done.stop, null);
  assert.equal(done.state.st.stage, "open-pr");
  assert.equal(done.state.st.prTitle, `${"t".repeat(TITLE_LIMIT)}…`);
  assert.equal(
    done.state.st.prBody,
    "Does the thing, tested in src/a.test.ts.",
  );
  assert.deepEqual(done.state.st.prBy, IMPL_BY);
  assert.deepEqual(done.comments, []);
});

test("a second handoff stops: the issue needs splitting", () => {
  const step = replied(buildState("implement", { continuations: 1 }), {
    status: "handoff",
    summary: "Still not done.",
  });
  assert.deepEqual(step.stop, {
    reason: "the implementer ran out of room twice; the issue needs splitting",
    detail: `Latest handoff: ${HANDOFF}\n\nStill not done.`,
    code: null,
  });
  assert.deepEqual(step.comments, [
    { by: IMPL_BY, body: "Still not done.", where: "issue" },
  ]);
});

test("a blocked implementer stops with its summary", () => {
  const step = replied(buildState("implement"), {
    status: "blocked",
    summary: "The API is gone.",
  });
  assert.deepEqual(step.stop, {
    reason: "the implementer could not do the issue as written",
    detail: "The API is gone.",
    code: null,
  });
  assert.deepEqual(step.comments, [
    { by: IMPL_BY, body: "The API is gone.", where: "issue" },
  ]);
});

test("a failed session or a malformed reply stops", () => {
  const begun = next(buildState("implement"), BUILD_CTX, []);
  const failed = afterSession(next, begun, IMPL_BY, {
    ok: false,
    structuredOutput: null,
    error: "timeout",
  });
  assert.deepEqual(failed.stop, {
    reason: "the implementer session failed",
    detail: "timeout",
    code: null,
  });
  const malformed = afterSession(next, begun, IMPL_BY, {
    ok: true,
    structuredOutput: { status: "done" },
  });
  assert.equal(malformed.stop?.reason, "the implementer session failed");
});
