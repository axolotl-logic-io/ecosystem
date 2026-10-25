// Mutation authority must not inherit the compatibility reader's lossy defaults.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueState } from "../src/state.ts";
import "./isolated-root-test-kit.ts";
import { credentialConfig } from "./credentials-test-kit.ts";
import { saveAuthority } from "./write-authority-test-kit.ts";

const { testConfig }: typeof import("./config-test-kit.ts") = await import(
  "./config-test-kit.ts"
);
const { readState, readWriteState }: typeof import("../src/saved-state.ts") =
  await import("../src/saved-state.ts");
const { readWriteAuthority }: typeof import("../src/write-authority.ts") =
  await import("../src/write-authority.ts");
const { newIssueState }: typeof import("../src/state.ts") = await import(
  "../src/state.ts"
);
const { refuseOnceMerged, pushOps }: typeof import("../src/ops/push.ts") =
  await import("../src/ops/push.ts");
const ISSUE = 7;
const SHA_LENGTH = 40;
const INVALID = /write authority/u;
const { cfg } = testConfig({
  repo: "o/authority",
  allowedUsers: ["alice"],
  ...credentialConfig("bot"),
});
const valid: IssueState = {
  ...newIssueState(ISSUE),
  branch: "agent/issue-7",
  stage: "implement",
};

const MERGED_PUSH = /code merged, so test can't push code/u;

test("current saved state authorizes premerge code; codeMerged and own-merge receipts each close it", () => {
  saveAuthority(cfg, valid);
  assert.equal(readWriteAuthority(cfg, ISSUE).codeWritable, true);
  for (const receipt of [
    { codeMerged: { pr: 42, sha: "merged" } },
    {
      mergeAttempt: {
        repo: cfg.repo,
        pr: 42,
        target: cfg.baseBranch,
        branch: valid.branch,
        authorized: {
          code: "a".repeat(SHA_LENGTH),
          inputs: "trusted",
        },
        hardened: {
          code: "a".repeat(SHA_LENGTH),
          inputs: "trusted",
        },
        integration: null,
        result: null,
        reads: 0,
      },
    },
    { merged: { code: "merged", inputs: "trusted" } },
    {
      security: {
        revision: { code: null, wiki: "unsafe", inputs: "trusted" },
        commentId: 9,
        finding: { category: "rights", reason: "rejected" },
      },
    },
  ]) {
    saveAuthority(cfg, { ...valid, ...receipt });
    assert.equal(readWriteAuthority(cfg, ISSUE).codeWritable, false);
    assert.throws(() => refuseOnceMerged(cfg, ISSUE, "test"), MERGED_PUSH);
  }
});

test("missing, legacy, mismatched and malformed critical authority fail closed, unlike tolerant display reads", () => {
  const { branch: _branch, ...withoutBranch } = valid;
  const { codeMerged: _codeMerged, ...withoutReceipt } = valid;
  const { merged: _merged, ...withoutOwnReceipt } = valid;
  const invalid = [
    null,
    { version: 1, stage: "implement" },
    { ...valid, number: ISSUE + 1 },
    { ...valid, stage: "unknown" },
    { ...valid, stoppedStage: "unknown" },
    { ...valid, stopCode: {} },
    { ...valid, hardened: {} },
    { ...valid, integration: {} },
    { ...valid, security: {} },
    { ...valid, mergeAttempt: {} },
    { ...valid, gherkin: {} },
    withoutBranch,
    withoutReceipt,
    withoutOwnReceipt,
    { ...valid, codeMerged: { pr: "broken", sha: "merged" } },
    { ...valid, merged: { code: "merged" } },
  ];
  const operations = new Map(Object.entries(pushOps));
  for (const state of invalid) {
    saveAuthority(cfg, state);
    assert.throws(() => readWriteAuthority(cfg, ISSUE), INVALID);
    assert.throws(() => readWriteState(cfg, ISSUE), INVALID);
    assert.throws(() => refuseOnceMerged(cfg, ISSUE, "test"), INVALID);
    for (const op of ["push", "exit-push"]) {
      const mutate = operations.get(op);
      assert.ok(mutate);
      assert.throws(
        () => mutate(cfg, { number: ISSUE, state: valid }),
        INVALID,
      );
    }
  }
  saveAuthority(cfg, { ...valid, codeMerged: { pr: "broken" } });
  assert.equal(readState(cfg, ISSUE).state?.codeMerged, null);
  assert.throws(() => readWriteAuthority(cfg, ISSUE), INVALID);
});
