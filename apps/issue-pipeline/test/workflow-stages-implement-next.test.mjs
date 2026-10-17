// @ts-check
// Implement's step machine (src/workflow/stages/implement.ts), driven directly
// with recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin the prompt, the continuation and each status's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { next } from "../src/workflow/stages/implement.ts";
import { asSessions, sessions } from "./stage-outcome-test-kit.mjs";
import {
  afterReply,
  afterSession,
  BUILD_CTX,
  buildState,
  HANDOFF,
  IMPL_BY,
  implementLaunch,
  implementTask,
  PLAN,
  SPEC,
  STAMP,
} from "./workflow-build-test-kit.mjs";

/** @import { StageContext, StageState, Step } from "../src/workflow/stages/types.ts" */
/** @typedef {Readonly<Record<string, unknown>>} Reply */

const TITLE_LIMIT = 200;
// The lead a first session from a spec gets: a restart resumes implement
// with the handoff of the session before the stop (`every-role-resumes`).
const EARLIER_HANDOFF = `If ${HANDOFF} exists, an earlier implementer session of this issue wrote it before the issue stopped: read it and the commits on the branch first, and build on them.\n\n`;
const HANDOFF_LINE = `A previous session ran out of room. Read its handoff first: ${HANDOFF}. Continue from the current branch state.`;
const CONTINUED =
  "This session ran out of room before finishing. Another implementer session continues from its handoff.";

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
/** @param {StageState} state @param {Reply} fields @param {StageContext} [ctx] @returns {Step} */
function replied(state, fields, ctx = BUILD_CTX) {
  const begun = next(state, ctx, []);
  const output = replyOf(fields);
  return next(begun.state, ctx, [
    {
      kind: "child",
      ok: true,
      error: null,
      by: IMPL_BY,
      structuredOutput: output,
    },
  ]);
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
    implementer(
      implementTask(
        `${EARLIER_HANDOFF}Spec (also posted on the issue):\n${SPEC}`,
      ),
    ),
  );
  assert.equal(sessions(step)[0]?.agent, "issue-pipeline-writer");
  assert.equal(step.state.phase, "decide");
  assert.deepEqual(given, buildState("implement", { spec: SPEC }));
});

test("a restart's unwritten spec files lead the session's task", () => {
  const files = ["test/a.test.mjs", "src/b.ts"];
  const given = buildState("implement", { spec: SPEC, unwrittenFiles: files });
  const [session] = sessions(next(given, BUILD_CTX, []));
  assert.ok(
    session?.task.includes(
      "The spec documents these test or stub files, which the branch lacks; write them as part of this work: `test/a.test.mjs`, `src/b.ts`.",
    ),
  );
});

test("without a spec the session works from triage's plan", () => {
  const step = next(buildState("implement"), BUILD_CTX, []);
  assert.deepEqual(
    sessions(step),
    implementer(implementTask(`Triage plan:\n${PLAN}`)),
  );
});

test("a handoff, then a continuation, then done and its push moves the issue to open-pr", () => {
  const first = replied(buildState("implement", { spec: SPEC }), {
    status: "handoff",
    summary: "Half done.",
  });
  assert.equal(first.done, true);
  assert.equal(first.stop, null);
  assert.equal(first.state.st.stage, "implement");
  assert.deepEqual(first.state.st.continuations, { implement: 1 });
  assert.deepEqual(first.comments, [
    { by: IMPL_BY, body: `${CONTINUED}\n\nHalf done.`, where: "issue" },
  ]);
  assert.deepEqual(first.state.st.log, [
    `${STAMP} implement: handoff - Half done.`,
  ]);
  const again = begunAgain(first);
  assert.deepEqual(sessions(again), implementer(implementTask(HANDOFF_LINE)));
  const pushing = afterSession(next, again, IMPL_BY, {
    ok: true,
    structuredOutput: replyOf({ prTitle: "t".repeat(TITLE_LIMIT + 1) }),
  });
  const done = afterReply(next, pushing, { ok: true, headSha: "bbbbbbb" });
  assert.equal(done.done, true);
  assert.equal(done.state.st.headSha, "bbbbbbb");
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

// A state saved before #269 counted the implementer's continuations as a
// number; it still reads as the implementer's count.
test("a second handoff stops: the issue needs splitting", () => {
  const step = replied(buildState("implement", { continuations: 1 }), {
    status: "handoff",
    summary: "Still not done.",
  });
  assert.equal(step.done, true);
  assert.equal(stopFor(step.stop?.reason)?.code, "too-large");
  assert.equal(
    step.stop?.detail,
    `Latest handoff: ${HANDOFF}\n\nStill not done.`,
  );
  assert.deepEqual(step.comments, [
    { by: IMPL_BY, body: "Still not done.", where: "issue" },
  ]);
});

test("maxContinuations 2 lets a second handoff continue and stops a third", () => {
  const ctx = { ...BUILD_CTX, cfg: { ...BUILD_CTX.cfg, maxContinuations: 2 } };
  const handoff = { status: "handoff", summary: "Not done." };
  const second = replied(
    buildState("implement", { continuations: { implement: 1 } }),
    handoff,
    ctx,
  );
  assert.equal(second.stop, null);
  assert.deepEqual(second.state.st.continuations, { implement: 2 });
  const third = replied({ ...second.state, phase: "begin" }, handoff, ctx);
  assert.equal(stopFor(third.stop?.reason)?.code, "too-large");
});

test("maxContinuations 0 stops the first handoff", () => {
  const ctx = { ...BUILD_CTX, cfg: { ...BUILD_CTX.cfg, maxContinuations: 0 } };
  const handoff = { status: "handoff", summary: "Not done." };
  const stopped = replied(buildState("implement"), handoff, ctx);
  assert.equal(stopFor(stopped.stop?.reason)?.code, "too-large");
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
