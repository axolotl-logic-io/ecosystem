// @ts-check
// Spec's step machine (src/workflow/stages/spec.ts), driven directly with
// recorded results and a fixed clock. The trace tests run it through the
// sweep; these pin the prompt and each decision's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/spec.ts";
import {
  asSessions,
  opsRequests,
  sessions,
} from "./stage-outcome-test-kit.mjs";
import {
  afterReply,
  afterSession,
  BUILD_CTX,
  buildState,
  PATHS,
  SPEC,
  SPEC_BY,
  SPEC_END,
  SPEC_REPLY,
  STAMP,
  specLaunch,
  specTask,
} from "./workflow-build-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

const SPEC_LIMIT = 12_000;
const START_FROM = /start from/u;
const QUESTIONS = ["Which file holds the thing?"];
const FILES = ["src/thing.ts", "test/**"];
const SPEC_FILE = "/w/runs/o__r/issue-7/spec.md";
// Spec's step after its session ends with `result`.
/** @param {Parameters<typeof afterSession>[3]} result @returns {Step} */
function decided(result) {
  const begun = next(buildState("spec"), BUILD_CTX, []);
  return afterSession(next, begun, SPEC_BY, result);
}

// Spec's step after its session replies with `fields` over a whole ready spec.
/** @param {Readonly<Record<string, unknown>>} fields @returns {Step} */
function replied(fields) {
  const output = {
    decision: "ready",
    spec: SPEC_REPLY,
    questions: [],
    files: FILES,
    subIssues: [],
    ...fields,
  };
  return decided({ ok: true, structuredOutput: output });
}

test("the first call charges the spec writer and launches its session", () => {
  const given = buildState("spec");
  const step = next(given, BUILD_CTX, []);
  assert.equal(step.done, false);
  assert.deepEqual(sessions(step), asSessions([specLaunch(specTask())]));
  assert.equal(step.state.phase, "decide");
  assert.deepEqual([step.comments, step.stop], [[], null]);
  assert.deepEqual(given, buildState("spec"));
});

test("without a wiki the task names no wiki start page", () => {
  const paths = { ...PATHS, wiki: null };
  const step = next(buildState("spec", {}, paths), BUILD_CTX, []);
  assert.equal(step.done, false);
  const [session] = sessions(step);
  assert.deepEqual([session], asSessions([specLaunch(specTask(paths))]));
  assert.doesNotMatch(session?.task ?? "", START_FROM);
});

test("a whole ready spec is kept without its marker, posted, and moves the issue to implement", () => {
  const step = replied({ spec: `${SPEC_REPLY}\n  \n` });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "implement");
  assert.equal(step.state.st.spec, SPEC);
  assert.equal(step.state.st.specFile, undefined);
  assert.deepEqual(step.state.st.files, FILES);
  // This spec writer leaves the spec's tests to the implementer (#305).
  assert.equal(step.state.st.specWritesTests, false);
  assert.deepEqual(step.state.st.log, [`${STAMP} spec: ready`]);
  assert.deepEqual(step.comments, [
    {
      by: SPEC_BY,
      body: `## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.\n\n${SPEC}`,
      where: "issue",
    },
  ]);
});

test("a ready spec longer than 12,000 characters is saved whole to spec.md first", () => {
  const long = `${SPEC}\n${"x".repeat(SPEC_LIMIT)}`;
  const step = replied({ spec: `${long}\n${SPEC_END}` });
  assert.equal(step.done, false);
  assert.deepEqual(step.comments, []);
  assert.deepEqual(opsRequests(step), [
    { op: "save-spec", payload: { number: 7, spec: long } },
  ]);
  const saved = afterReply(next, step, {
    ok: true,
    op: "save-spec",
    posted: 0,
    specFile: SPEC_FILE,
  });
  assert.equal(saved.done, true);
  assert.equal(saved.stop, null);
  assert.equal(saved.state.st.stage, "implement");
  assert.equal(saved.state.st.spec, `${long.slice(0, SPEC_LIMIT)}…`);
  assert.equal(saved.state.st.specFile, SPEC_FILE);
  assert.deepEqual(saved.state.st.files, FILES);
  assert.deepEqual(saved.comments, [
    {
      by: SPEC_BY,
      body: `## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.\n\n${long}`,
      where: "issue",
    },
  ]);
});

test("a full spec that can't be saved stops at spec, unposted", () => {
  const long = `${SPEC}\n${"x".repeat(SPEC_LIMIT)}`;
  const step = replied({ spec: `${long}\n${SPEC_END}` });
  const failed = afterReply(next, step, { ok: false, error: "disk full" });
  assert.deepEqual(failed.stop, {
    reason: "could not save the full spec",
    detail: "disk full",
    code: null,
  });
  assert.equal(failed.state.st.stage, "spec");
  assert.deepEqual(failed.comments, []);
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
  assert.deepEqual(opsRequests(step), [
    {
      op: "ask",
      payload: {
        number: 7,
        state: { ...step.state.st, stage: "triage" },
        questions: QUESTIONS,
        by: SPEC_BY,
      },
    },
  ]);
  assert.equal(step.state.st.stage, "spec");
  assert.deepEqual(step.state.st.log, [`${STAMP} spec: needs-info`]);
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

test("the task asks for the end marker as the last line of spec", () => {
  const [session] = sessions(next(buildState("spec"), BUILD_CTX, []));
  assert.ok(session?.task.includes("<!-- end of spec -->"));
});

test("an unknown phase throws", () => {
  const state = { ...buildState("spec"), phase: "later" };
  assert.throws(() => next(state, BUILD_CTX, []), {
    message: "spec: unknown phase later",
  });
});
