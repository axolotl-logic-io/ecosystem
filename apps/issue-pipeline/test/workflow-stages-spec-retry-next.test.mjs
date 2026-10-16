// @ts-check
// Spec's retry (src/workflow/stages/spec.ts, #280): a failed spec session, one
// whose reply doesn't fit the schema or whose spec lacks its end marker, is
// tried once more within the spec budget, then stops the issue.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/spec.ts";
import { asSessions, sessions } from "./stage-outcome-test-kit.mjs";
import {
  afterSession,
  BUILD_CTX,
  buildState,
  SPEC,
  SPEC_BY,
  SPEC_END,
  SPEC_REPLY,
  specLaunch,
  specTask,
} from "./workflow-build-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

const FILES = ["src/thing.ts"];
const TWICE = "the spec writer failed twice";
const CUT_SHORT = `its spec did not end with ${SPEC_END}, so it may stop partway`;
const MISFIT = "its reply did not fit the schema";
// A spec session that ends early, and a reply with no marker.
const TIMED_OUT = { ok: false, structuredOutput: null, error: "timeout" };
const UNMARKED = {
  ok: true,
  structuredOutput: {
    decision: "ready",
    spec: SPEC,
    questions: [],
    files: FILES,
    subIssues: [],
  },
};
// A whole ready reply.
const MARKED = {
  ok: true,
  structuredOutput: {
    decision: "ready",
    spec: SPEC_REPLY,
    questions: [],
    files: FILES,
    subIssues: [],
  },
};

// Spec's step after its first session ends with `result`.
/** @param {Parameters<typeof afterSession>[3]} result @returns {Step} */
function decided(result) {
  const begun = next(buildState("spec"), BUILD_CTX, []);
  return afterSession(next, begun, SPEC_BY, result);
}

// Spec's step after its second session ends with `second`, the first having
// ended with `first`.
/** @param {Parameters<typeof afterSession>[3]} first @param {Parameters<typeof afterSession>[3]} second @returns {Step} */
function retried(first, second) {
  return afterSession(next, decided(first), SPEC_BY, second);
}

test("a spec without its marker launches the spec writer once more", () => {
  const step = decided(UNMARKED);
  assert.equal(step.done, false);
  assert.equal(step.stop, null);
  assert.equal(step.state.phase, "decide-again");
  assert.deepEqual(sessions(step), asSessions([specLaunch(specTask())]));
  assert.deepEqual(step.comments, []);
  assert.equal(step.state.st.spec, undefined);
});

test("a second spec without its marker stops at spec, unposted", () => {
  const step = retried(UNMARKED, UNMARKED);
  assert.equal(step.done, true);
  assert.deepEqual(step.stop, { reason: TWICE, detail: CUT_SHORT, code: null });
  assert.equal(step.state.st.stage, "spec");
  assert.equal(step.state.st.spec, undefined);
  assert.deepEqual(step.comments, []);
});

test("a failed session, a malformed reply or one without files is tried once more, then stops", () => {
  const malformed = { ok: true, structuredOutput: { decision: "ok" } };
  const fileless = {
    ok: true,
    structuredOutput: { decision: "ready", spec: SPEC_REPLY, questions: [] },
  };
  for (const failure of [TIMED_OUT, malformed, fileless]) {
    assert.equal(decided(failure).state.phase, "decide-again");
  }
  assert.deepEqual(retried(MARKED, TIMED_OUT).state.st.stage, "implement");
  const stops = [
    retried(TIMED_OUT, TIMED_OUT),
    retried(TIMED_OUT, malformed),
    retried(malformed, fileless),
  ].map((step) => step.stop);
  assert.deepEqual(stops, [
    { reason: TWICE, detail: "timeout", code: null },
    { reason: TWICE, detail: MISFIT, code: null },
    { reason: TWICE, detail: MISFIT, code: null },
  ]);
});

test("a failed first session followed by a whole reply is kept as ready", () => {
  const step = retried(TIMED_OUT, MARKED);
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.equal(step.state.st.stage, "implement");
  assert.equal(step.state.st.spec, SPEC);
});
