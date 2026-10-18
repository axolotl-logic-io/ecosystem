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

// The step after an open-pr reply that reports `codeChanged` and `wikiAhead`.
/** @param {boolean} codeChanged @param {number} wikiAhead @returns {Step} */
function openedWith(codeChanged, wikiAhead) {
  const reply = { ok: true, pr: 43, headSha: "bbbbbbb", codeChanged };
  return afterReply(next, begun(), { ...reply, wikiAhead });
}

test("a code-only change goes to review with its flows", () => {
  const step = openedWith(true, 0);
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  const { flows, stage, prClosed } = step.state.st;
  assert.deepEqual(flows, { code: true, wiki: false });
  assert.equal(stage, "review");
  assert.equal(prClosed, undefined);
});

test("a change to code and the wiki goes to review as code only does", () => {
  const step = openedWith(true, 1);
  assert.equal(step.done, true);
  assert.deepEqual(step.state.st.flows, { code: true, wiki: true });
  assert.equal(step.state.st.stage, "review");
});

test("a wiki-only change closes the draft PR, then goes to review", () => {
  const closing = openedWith(false, 1);
  assert.equal(closing.done, false);
  assert.deepEqual(opsRequests(closing), [
    { op: "close-pr", payload: { number: 7, pr: 43 } },
  ]);
  const step = afterReply(next, closing, { ok: true, pr: 43, closed: true });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  const { flows, stage, prClosed } = step.state.st;
  assert.deepEqual(flows, { code: false, wiki: true });
  assert.deepEqual({ stage, prClosed }, { stage: "review", prClosed: true });
});

test("a change that changed nothing stops as not doable", () => {
  const step = openedWith(false, 0);
  assert.deepEqual(step.stop, {
    reason: "the implementation changed nothing",
    detail: null,
    code: null,
  });
});

// The PR a wiki-only issue closed, which a later fix's code reopens.
const CLOSED_PR = 42;

test("an issue whose PR was closed reopens it, and goes to review once it is open", () => {
  const closed = { ...IMPLEMENTED, pr: CLOSED_PR, prClosed: true };
  const begin = next(buildState("open-pr", closed), BUILD_CTX, []);
  const [request] = opsRequests(begin);
  assert.equal(request?.op, "open-pr");
  const { reopen } = request?.payload ?? {};
  assert.equal(reopen, CLOSED_PR);
  const reply = {
    ok: true,
    pr: CLOSED_PR,
    headSha: "bbbbbbb",
    codeChanged: true,
  };
  const step = afterReply(next, begin, { ...reply, wikiAhead: 1 });
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  const { pr, prClosed, stage } = step.state.st;
  assert.deepEqual(
    { pr, prClosed, stage },
    { pr: CLOSED_PR, prClosed: false, stage: "review" },
  );
});
