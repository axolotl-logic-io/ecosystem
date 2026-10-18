// @ts-check
// Mutation authority must not inherit the compatibility reader's lossy defaults.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { saveAuthority } from "./write-authority-test-kit.mjs";

const { loadConfig } = await import("../src/config.ts");
const { readState, readWriteState } = await import("../src/saved-state.ts");
const { readWriteAuthority } = await import("../src/write-authority.ts");
const { newIssueState } = await import("../src/state.ts");
const { refuseOnceMerged, pushOps } = await import("../src/ops/push.ts");
const ISSUE = 7;
const INVALID = /write authority/u;
const file = path.join(isolatedRoot, "authority-config.json");
fs.writeFileSync(
  file,
  JSON.stringify({
    repo: "o/authority",
    account: "bot",
    allowedUsers: ["alice"],
    commands: { test: "true" },
  }),
);
const cfg = loadConfig(file);
const valid = {
  ...newIssueState(ISSUE),
  branch: "agent/issue-7",
  stage: "implement",
};

test("current saved state authorizes premerge code; codeMerged and own-merge receipts each close it", () => {
  saveAuthority(cfg, valid);
  assert.equal(readWriteAuthority(cfg, ISSUE).codeWritable, true);
  for (const receipt of [
    { codeMerged: { pr: 42, sha: "merged" } },
    { merged: { code: "merged", wiki: null, inputs: "trusted" } },
  ]) {
    saveAuthority(cfg, { ...valid, ...receipt });
    assert.equal(readWriteAuthority(cfg, ISSUE).codeWritable, false);
    assert.throws(() => refuseOnceMerged(cfg, ISSUE, "test"));
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
