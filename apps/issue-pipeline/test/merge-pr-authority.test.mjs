// @ts-check
// Exact head authorization does not authorize a different PR target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  ISSUE,
  MERGE_COMMIT,
  prView,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");
const TARGET_REFUSAL = /targets .+, not integration/u;

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {{ code: string, wiki: null, inputs: string }} */
function approvedOf(w) {
  return { code: w.sha, wiki: null, inputs: "inputs-1" };
}

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {object} */
function request(w) {
  const approved = approvedOf(w);
  return {
    number: ISSUE,
    state: approvedState(approved),
    expectedSha: w.sha,
    revision: approved,
  };
}

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {void} */
function current(w) {
  setCurrentRevision({ revision: approvedOf(w), baseSha: "base", pr: null });
}

for (const baseRefName of ["main", "other"]) {
  for (const state of ["OPEN", "MERGED"]) {
    test(`merge refuses exact-head ${state} PR targeting ${baseRefName}`, () => {
      const w = world();
      current(w);
      fakeGh.reply([
        prView({
          headRefOid: w.sha,
          baseRefName,
          state,
          mergeCommit: { oid: MERGE_COMMIT },
        }),
      ]);
      assert.throws(() => merge(w.cfg, request(w)), TARGET_REFUSAL);
      assert.deepEqual(writes(), []);
    });
  }
}

test("merge rechecks the actual target after revision and base prechecks before mutation", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha, baseRefName: "main" }),
  ]);
  assert.throws(() => merge(w.cfg, request(w)), TARGET_REFUSAL);
  assert.deepEqual(writes(), []);
});

// This is detection after a possible branch write, NOT prevention of the
// target check/use race: both prior views were on the configured base.
test("merge refuses a wrong-target receipt without signing a merge comment", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha }),
    { when: "pr merge 50" },
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      baseRefName: "main",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  assert.throws(() => merge(w.cfg, request(w)), TARGET_REFUSAL);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0]?.[1], "merge");
});
