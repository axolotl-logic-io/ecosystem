// @ts-check
// Literal branch validation in process; git's own syntax validator is local only.
import assert from "node:assert/strict";
import { test } from "node:test";
import "../isolated-root-test-kit.mjs";

const { testConfig } = await import("../config-test-kit.mjs");

const { branchRefusalOf } = await import("../../src/job/branch.ts");
const { cfg } = testConfig();
const ISSUE = 7;
const INVALID = [
  "-delete",
  "refs/heads/agent/issue-7",
  "HEAD",
  "@{-1}",
  "agent/issue..7",
  "agent/issue-7.lock",
  "agent issue-7",
  "agent.lock/issue-7",
  "-f",
  "refs/heads/x",
  "a..b",
  "x@{1}",
  "a b",
  "x.lock",
  cfg.baseBranch,
];
for (const branch of INVALID) {
  test(`branch ${branch} cannot name issue work`, () => {
    assert.notEqual(branchRefusalOf(cfg, ISSUE, branch, false), null);
  });
}
test("a literal feature branch can name issue work", () => {
  assert.equal(branchRefusalOf(cfg, ISSUE, "feature/assigned-7", false), null);
});
