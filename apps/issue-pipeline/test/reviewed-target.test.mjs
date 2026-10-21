// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubComment } from "./fake-gh.mjs";
import { hardening } from "./roles/reviewer/reviewer-role-test-kit.mjs";
import {
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "./roles/reviewer-and-merge-role-calls-test-kit.mjs";
import {
  cfg,
  current,
  REVISION,
  reviewerRole,
  sha,
} from "./roles/reviewer-and-merge-role-test-kit.mjs";

const { parseIssueState, readClaimState } = await import(
  "../src/saved-state.ts"
);
const { COMMENT } = await import("../src/comments.ts");
const { newIssueState } = await import("../src/state.ts");
const ISSUE = 7;
const TARGET = {
  repo: cfg.repo,
  branch: cfg.baseBranch,
  sha: current().baseSha,
};
const INVALID_AUTHORITY = /saved write authority is invalid/u;

/** @param {unknown} raw */
function authority(raw) {
  return readClaimState(cfg, ISSUE, [
    COMMENT.parse(
      githubComment({
        id: 900,
        login: cfg.mergeAccount,
        created: "2026-10-21T00:00:00Z",
        body: `**🤖 issue-pipeline · state**\n<!-- agent-pipeline:state\n${JSON.stringify(raw)}\n-->`,
      }),
    ),
  ]);
}

test("fresh hardening retains the literal repository/branch/base revision reviewed and checked", async () => {
  const { ctx, calls } = hardening();
  const end = await reviewerRole(ctx);
  assert.deepEqual(stateOf(end, "next").hardenedTarget, TARGET);
  assert.deepEqual(savesOf(calls)[0]?.hardenedTarget, TARGET);
  assert.equal(sessionsOf(calls).length, 1);
  assert.ok(opNames(calls).includes("verify"));
});

for (const target of [
  null,
  { ...TARGET, repo: "wrong/repository" },
  { ...TARGET, branch: "other" },
  { ...TARGET, sha: sha("d") },
]) {
  test(`unmerged saved hardening cannot reuse an unknown or changed target: ${JSON.stringify(target)}`, async () => {
    const { ctx, calls } = hardening({
      state: { hardened: REVISION, hardenedTarget: target },
    });
    const end = await reviewerRole(ctx);
    assert.equal(sessionsOf(calls).length, 1);
    assert.ok(opNames(calls).includes("verify"));
    assert.deepEqual(stateOf(end, "next").hardenedTarget, TARGET);
  });
}

test("target movement during hardening cannot checkpoint approval against a newly advertised ancestor", async () => {
  const { ctx, calls } = hardening({
    after: { ...current(), baseSha: sha("d") },
  });
  const end = await reviewerRole(ctx);
  const state = stateOf(end, "next");
  assert.equal(state.stage, "review");
  assert.equal(state.hardened, null);
  assert.equal(state.hardenedTarget, null);
  assert.equal(savesOf(calls).length, 0);
  assert.equal(opNames(calls).includes("ready-pr"), false);
});

test("old absent target remains readable without inventing historical authority; malformed target fails write validation", () => {
  const state = newIssueState(ISSUE);
  const { hardenedTarget: _target, ...old } = state;
  assert.equal(parseIssueState(old, ISSUE)?.hardenedTarget, null);
  assert.equal(authority(old)?.hardenedTarget, null);
  for (const target of [
    {},
    { ...TARGET, sha: "HEAD" },
    { ...TARGET, sha: sha("A") },
    { ...TARGET, repo: "" },
    { ...TARGET, branch: "" },
  ]) {
    assert.throws(
      () => authority({ ...state, hardenedTarget: target }),
      INVALID_AUTHORITY,
    );
  }
});
