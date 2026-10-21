// @ts-check
// Strict saved authority validates candidate phase and literal target together.
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubComment } from "./fake-gh.mjs";
import {
  cfg,
  REVISION,
  sha,
} from "./roles/reviewer-and-merge-role-test-kit.mjs";

const { COMMENT } = await import("../src/comments.ts");
const { parseIssueState, readClaimState } = await import(
  "../src/saved-state.ts"
);
const { newIssueState } = await import("../src/state.ts");
const ISSUE = 7;
const TARGET = { repo: cfg.repo, branch: cfg.baseBranch, sha: sha("b") };
const HISTORICAL = { revision: REVISION, commentId: 51, finding: null };
const CANDIDATE = { ...HISTORICAL, phase: "candidate", target: TARGET };
const INVALID_AUTHORITY = /saved write authority is invalid/u;

/** @param {unknown} security */
function authority(security) {
  const state = { ...newIssueState(ISSUE), security };
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

test("candidate phase and shared target survive strict saved-authority parsing", () => {
  assert.deepEqual(authority(CANDIDATE)?.security, CANDIDATE);
});

test("phase-absent historical receipts stay readable without inventing target authority", () => {
  assert.deepEqual(authority(HISTORICAL)?.security, HISTORICAL);
  const old = { ...newIssueState(ISSUE), security: HISTORICAL };
  const { hardenedTarget: _target, ...withoutTarget } = old;
  assert.equal(parseIssueState(withoutTarget, ISSUE)?.hardenedTarget, null);
  assert.deepEqual(parseIssueState(withoutTarget, ISSUE)?.security, HISTORICAL);
});

for (const security of [
  { ...HISTORICAL, phase: "candidate" },
  { ...HISTORICAL, target: TARGET },
  { ...CANDIDATE, phase: "postmerge" },
  { ...CANDIDATE, target: null },
  ...[
    {},
    { ...TARGET, repo: "" },
    { ...TARGET, branch: "" },
    { ...TARGET, sha: "HEAD" },
    { ...TARGET, sha: sha("A") },
  ].map((target) => ({ ...CANDIDATE, target })),
]) {
  test(`malformed paired Security provenance refuses saved write authority: ${JSON.stringify(security)}`, () => {
    assert.throws(() => authority(security), INVALID_AUTHORITY);
  });
}
