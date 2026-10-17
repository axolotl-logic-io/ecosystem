// @ts-check
// Spec's split (src/workflow/stages/spec.ts and spec-split.ts), driven
// directly with recorded results and a fixed clock: the spec writer cuts an
// issue too big for one session into sub-issues, which the split op opens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/spec.ts";
import { opsRequests, sessions } from "./stage-outcome-test-kit.mjs";
import {
  afterReply,
  afterSession,
  BUILD_CTX,
  buildState,
  SPEC_BY,
  SPEC_REPLY,
  STAMP,
} from "./workflow-build-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */
/** @typedef {Parameters<typeof buildState>[1]} Fields */

const NOT_ALLOWED = /splitting is not allowed/u;

// Two parts of a split, the second after the first.
const FIRST = {
  title: "First part",
  body: "Do the first part.",
  after: [],
};
const SECOND = {
  title: "Second part",
  body: "Do the second part.",
  after: [0],
};
const PARTS = [FIRST, SECOND];

// Spec's step after its session replies with a split into `subIssues`.
/** @param {readonly object[]} subIssues @param {Fields} [fields] @returns {Step} */
function splitInto(subIssues, fields = {}) {
  const begun = next(buildState("spec", fields), BUILD_CTX, []);
  const output = {
    decision: "split",
    spec: SPEC_REPLY,
    questions: [],
    subIssues,
  };
  return afterSession(next, begun, SPEC_BY, {
    ok: true,
    structuredOutput: output,
  });
}

// The spec writer's task for issue #7 with `fields` in its state.
/** @param {Fields} fields @returns {string} */
function taskWith(fields) {
  const [session] = sessions(next(buildState("spec", fields), BUILD_CTX, []));
  return session?.task ?? "";
}

// A part's body goes out as the spec writer wrote it, with no Files line
// (#391): it names entry points only where the part has stubs.
test("a split at depth 0 opens its parts through the split op, each body as written", () => {
  const step = splitInto(PARTS);
  assert.equal(step.done, false);
  assert.deepEqual(opsRequests(step), [
    {
      op: "split",
      payload: {
        number: 7,
        state: step.state.st,
        subIssues: [
          {
            title: "First part",
            body: "Do the first part.",
            after: [],
          },
          {
            title: "Second part",
            body: "Do the second part.",
            after: [0],
          },
        ],
        by: SPEC_BY,
      },
    },
  ]);
  assert.deepEqual([step.state.closed, step.state.outcome], [true, "split"]);
  assert.deepEqual(step.comments, []);
  assert.equal(step.state.st.spec, undefined);
  assert.equal(step.state.st.log?.at(-1), `${STAMP} spec: split`);
  const posted = afterReply(next, step, { ok: true });
  assert.equal(posted.done, true);
  assert.deepEqual([posted.comments, posted.stop], [[], null]);
});

test("a split that fails to post aborts the sweep", () => {
  const step = splitInto(PARTS);
  assert.throws(() => afterReply(next, step, { ok: false, error: "gh down" }), {
    message: "spec follow-up failed: gh down",
  });
});

test("a sub-issue's split and a one-part split stop at spec with no op", () => {
  const nested = splitInto(PARTS, { depth: 1 });
  assert.equal(nested.stop?.reason, "a sub-issue can't split again");
  const single = splitInto([FIRST]);
  assert.equal(
    single.stop?.reason,
    "the spec writer's split had fewer than 2 parts",
  );
  for (const step of [nested, single]) {
    assert.equal(step.done, true);
    assert.equal(Object.hasOwn(step, "launches"), false);
    assert.equal(step.state.st.stage, "spec");
  }
});

test("a suggested split gives the spec writer triage's reason", () => {
  const task = taskWith({ splitSuggested: "Three subsystems change." });
  assert.ok(task.includes("Three subsystems change."));
  assert.equal(task.includes("Triage found this issue ready."), false);
});

test("a sub-issue's spec writer is told splitting is not allowed", () => {
  assert.match(taskWith({ depth: 1 }), NOT_ALLOWED);
  assert.doesNotMatch(taskWith({}), NOT_ALLOWED);
});
