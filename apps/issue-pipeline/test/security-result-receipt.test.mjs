// @ts-check
// A result observation is strict, policy-bound and never candidate authority.
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubComment } from "./fake-gh.mjs";
import {
  cfg,
  REVISION,
  sha,
} from "./roles/reviewer-and-merge-role-test-kit.mjs";

const { COMMENT } = await import("../src/comments.ts");
const { readClaimState, parseIssueState, stateBody } = await import(
  "../src/saved-state.ts"
);
const { newIssueState } = await import("../src/state.ts");
const ISSUE = 7;
const OBSERVED = {
  revision: { ...REVISION, policy: REVISION.policy ?? "" },
  commentId: 51,
  finding: null,
  target: { repo: cfg.repo, branch: cfg.baseBranch, sha: sha("b") },
};
const INVALID = /saved write authority is invalid/u;
/** @param {unknown} resultSecurity */
function authority(resultSecurity) {
  const state = { ...newIssueState(ISSUE), resultSecurity };
  return readClaimState(cfg, ISSUE, [
    COMMENT.parse(
      githubComment({
        id: 900,
        login: cfg.mergeAccount,
        created: "2026-10-21T00:00:00Z",
        body: `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
      }),
    ),
  ]);
}

test("result observation parses without a candidate phase", () => {
  assert.deepEqual(authority(OBSERVED)?.resultSecurity, OBSERVED);
});

test("legacy absent and explicit null result slots are equivalent without adding a key", () => {
  const old = newIssueState(ISSUE);
  const parsed = parseIssueState(old, ISSUE);
  assert.equal(parsed?.resultSecurity ?? null, null);
  assert.ok(!Object.hasOwn(parsed ?? {}, "resultSecurity"));
  assert.ok(!stateBody(ISSUE, parsed ?? old).includes("resultSecurity"));
  assert.equal(authority(null)?.resultSecurity, null);
});

for (const receipt of [
  { ...OBSERVED, phase: "candidate" },
  { ...OBSERVED, revision: { ...OBSERVED.revision, policy: "not-a-digest" } },
  { ...OBSERVED, extra: "unknown" },
  { ...OBSERVED, target: null },
  { ...OBSERVED, target: { ...OBSERVED.target, sha: "HEAD" } },
  { ...OBSERVED, revision: { code: REVISION.code, inputs: REVISION.inputs } },
]) {
  test(`invalid result observation refuses write authority: ${JSON.stringify(receipt)}`, () => {
    assert.throws(() => authority(receipt), INVALID);
  });
}
