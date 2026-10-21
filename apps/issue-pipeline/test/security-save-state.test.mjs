// @ts-check
// Save real state through authenticated fake GitHub; no pipeline jobs or git.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFixture } from "./config-fixtures.mjs";
import {
  approvedState,
  fakeGh,
  savedListing,
} from "./ops-publish-test-kit.mjs";

const { saveIssueState } = await import("../src/ops/save-state.ts");
const { readWriteState } = await import("../src/saved-state.ts");
const cfg = configFixture();
const ISSUE = 7;
const REVISION = { code: "candidate", inputs: "trusted-inputs" };
const CANDIDATE = { target: cfg.baseBranch, baseSha: "before" };
const CLEAR = {
  revision: REVISION,
  candidate: CANDIDATE,
  finding: null,
  commentId: 901,
};
const SAVED = approvedState(REVISION, {
  headSha: REVISION.code,
  security: CLEAR,
});

/** @param {import("../src/state.ts").IssueState} saved */
function serve(saved) {
  fakeGh.reply([
    { ...savedListing(saved), persistState: true },
    { when: "api -X PATCH repos/o/r/issues/comments/900", keep: true },
  ]);
}

for (const security of [
  { ...CLEAR, revision: { ...REVISION, inputs: "fresh-inputs" } },
  { ...CLEAR, candidate: { ...CANDIDATE, baseSha: "after" } },
  { ...CLEAR, candidate: { ...CANDIDATE, target: "other" } },
]) {
  test(`fresh clearance persists after its binding changes: ${JSON.stringify(security)}`, () => {
    serve(SAVED);
    const state = { ...SAVED, hardened: security.revision, security };
    saveIssueState(cfg, ISSUE, state);
    assert.deepEqual(readWriteState(cfg, ISSUE).security, security);
  });
}

test("a stale save cannot erase exact candidate clearance", () => {
  serve(SAVED);
  saveIssueState(cfg, ISSUE, { ...SAVED, security: null });
  assert.deepEqual(readWriteState(cfg, ISSUE).security, CLEAR);
});

test("changing the target cannot replace a durable rejection of the same code and inputs", () => {
  const rejection = {
    ...CLEAR,
    finding: { category: /** @type {const} */ ("rights"), reason: "unsafe" },
  };
  serve({ ...SAVED, security: rejection });
  const security = { ...CLEAR, candidate: { ...CANDIDATE, baseSha: "after" } };
  saveIssueState(cfg, ISSUE, { ...SAVED, security });
  assert.deepEqual(readWriteState(cfg, ISSUE).security, rejection);
});

test("new trusted inputs can receive a new verdict without an obsolete rejection overwriting it", () => {
  serve({
    ...SAVED,
    security: {
      ...CLEAR,
      finding: { category: "rights", reason: "missing trusted consent" },
    },
  });
  const revision = { ...REVISION, inputs: "consent-granted" };
  const security = { ...CLEAR, revision };
  saveIssueState(cfg, ISSUE, { ...SAVED, hardened: revision, security });
  assert.deepEqual(readWriteState(cfg, ISSUE).security, security);
});

test("historical same-content rejection cannot be laundered into candidate clearance", () => {
  const rejection = {
    revision: REVISION,
    commentId: 901,
    finding: { category: /** @type {const} */ ("rights"), reason: "unsafe" },
  };
  serve({ ...SAVED, security: rejection });
  saveIssueState(cfg, ISSUE, { ...SAVED, security: CLEAR });
  assert.deepEqual(readWriteState(cfg, ISSUE).security, rejection);
});
