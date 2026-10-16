// @ts-check
// Open-pr's step machine (src/workflow/stages/open-pr.ts), driven directly
// with recorded replies and a fixed clock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/open-pr.ts";
import { opsRequests } from "./stage-outcome-test-kit.mjs";
import {
  afterReply,
  BUILD_CTX,
  buildState,
  IMPL_BY,
  STAMP,
} from "./workflow-build-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

const IMPLEMENTED = {
  prTitle: "Do the thing",
  prBody: "Does the thing.",
  prBy: IMPL_BY,
};

/** @returns {Step} */
function begun() {
  return next(buildState("open-pr", IMPLEMENTED), BUILD_CTX, []);
}

test("the first call asks ops to open the PR with the implementer's text", () => {
  const step = begun();
  assert.equal(step.done, false);
  assert.equal(step.state.phase, "opened");
  assert.deepEqual(opsRequests(step), [
    {
      op: "open-pr",
      payload: {
        number: 7,
        title: "Do the thing",
        body: "Does the thing.",
        by: IMPL_BY,
      },
    },
  ]);
});

test("an opened PR moves the issue to review", () => {
  const step = afterReply(next, begun(), {
    ok: true,
    pr: 43,
    headSha: "bbbbbbb",
  });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  const { pr, headSha, implemented, stage, log } = step.state.st;
  assert.deepEqual(
    { pr, headSha, implemented, stage, log },
    {
      pr: 43,
      headSha: "bbbbbbb",
      implemented: true,
      stage: "review",
      log: [`${STAMP} PR #43 is ready for review`],
    },
  );
});

test("a failing reply stops with its error", () => {
  const step = afterReply(next, begun(), { ok: false, error: "gh: 502" });
  assert.deepEqual(step.stop, {
    reason: "could not open the PR",
    detail: "gh: 502",
    code: null,
  });
  assert.equal(step.state.st.stage, "open-pr");
});

test("a reply without the PR number stops", () => {
  const step = afterReply(next, begun(), { ok: true });
  assert.deepEqual(step.stop, {
    reason: "could not open the PR",
    detail: null,
    code: null,
  });
});
