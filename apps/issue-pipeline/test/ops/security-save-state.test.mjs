// @ts-check
// Save real state through authenticated fake GitHub; no pipeline jobs or git.
import assert from "node:assert/strict";
import { test } from "node:test";
import { configFixture } from "../config-fixtures.mjs";
import {
  approvedState,
  fakeGh,
  savedListing,
} from "./ops-publish-test-kit.mjs";

const TARGET_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MOVED_TARGET_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const { saveIssueState } = await import("../../src/ops/save-state.ts");
const { readWriteState } = await import("../../src/saved-state.ts");
const cfg = configFixture();
const ISSUE = 7;
const REVISION = { code: "candidate", inputs: "trusted-inputs" };
const TARGET = { repo: cfg.repo, branch: cfg.baseBranch, sha: TARGET_SHA };
const CLEAR = {
  revision: REVISION,
  phase: /** @type {const} */ ("candidate"),
  target: TARGET,
  finding: null,
  commentId: 901,
};
const SAVED = approvedState(REVISION, {
  headSha: REVISION.code,
  hardenedTarget: TARGET,
  security: CLEAR,
});

/** @param {import("../../src/state.ts").IssueState} saved */
function serve(saved) {
  fakeGh.reply([
    { ...savedListing(saved), persistState: true },
    { when: "api -X PATCH repos/o/r/issues/comments/900", keep: true },
  ]);
}

for (const security of [
  { ...CLEAR, revision: { ...REVISION, inputs: "fresh-inputs" } },
  { ...CLEAR, target: { ...TARGET, sha: MOVED_TARGET_SHA } },
  { ...CLEAR, target: { ...TARGET, branch: "other" } },
  { ...CLEAR, target: { ...TARGET, repo: "other/repository" } },
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
  const security = { ...CLEAR, target: { ...TARGET, sha: MOVED_TARGET_SHA } };
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

// Result observations preserve candidate authority through lost/stale state saves.
const { policyRevision } = await import("../../src/project-policy.ts");
const { policyBinding: _binding, ...unboundConfig } = cfg;
const CHANGED_POLICY = policyRevision({
  ...unboundConfig,
  commandTimeoutMinutes: 123,
}).policy;
const RESULT_CLEAR = {
  revision: { ...REVISION, code: TARGET_SHA, ...policyRevision(cfg) },
  target: TARGET,
  finding: null,
  commentId: 902,
};

test("a stale save retains the result observation and original candidate receipt", () => {
  serve({ ...SAVED, resultSecurity: RESULT_CLEAR });
  const { resultSecurity: _missing, ...stale } = {
    ...SAVED,
    resultSecurity: RESULT_CLEAR,
  };
  saveIssueState(cfg, ISSUE, stale);
  const saved = readWriteState(cfg, ISSUE);
  assert.deepEqual(saved.resultSecurity, RESULT_CLEAR);
  assert.deepEqual(saved.security, CLEAR);
});

test("result rejection survives replacement by changed-policy approval of unchanged content", () => {
  const rejected = {
    ...RESULT_CLEAR,
    finding: {
      category: /** @type {const} */ ("rights"),
      reason: "private data",
    },
  };
  serve({ ...SAVED, resultSecurity: rejected });
  const changedPolicy = {
    ...RESULT_CLEAR,
    revision: { ...RESULT_CLEAR.revision, policy: CHANGED_POLICY },
  };
  saveIssueState(cfg, ISSUE, { ...SAVED, resultSecurity: changedPolicy });
  assert.deepEqual(readWriteState(cfg, ISSUE).resultSecurity, rejected);
});

test("fresh policy result observation replaces stale approval", () => {
  serve({ ...SAVED, resultSecurity: RESULT_CLEAR });
  const changedPolicy = {
    ...RESULT_CLEAR,
    revision: { ...RESULT_CLEAR.revision, policy: CHANGED_POLICY },
  };
  saveIssueState(cfg, ISSUE, { ...SAVED, resultSecurity: changedPolicy });
  assert.deepEqual(readWriteState(cfg, ISSUE).resultSecurity, changedPolicy);
});
