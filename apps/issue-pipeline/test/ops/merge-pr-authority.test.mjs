// @ts-check
// Exact head authorization does not authorize a different PR target.
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationClock } from "./confirmation-clock-test-kit.mjs";
import { setCurrentRevision } from "./fake-ops-publish-revision.mjs";
import { approvalReply } from "./merge-op-fixtures.mjs";
import {
  boundState,
  fakeGh,
  ISSUE,
  MERGE_COMMIT,
  mergeAuthority,
  prView,
  savedListing,
  sh,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../../src/ops/merge.ts");
const TARGET_REFUSAL = /targets .+, not integration/u;

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {{ code: string, inputs: string }} */
function approvedOf(w) {
  return { code: w.sha, inputs: "inputs-1" };
}

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {object} */
function request(w) {
  const approved = approvedOf(w);
  return {
    number: ISSUE,
    state: boundState(w, approved),
    expectedSha: w.sha,
    expectedBase: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    revision: approved,
  };
}

/** @param {import("./ops-publish-test-kit.mjs").World} w @returns {void} */
function current(w) {
  setCurrentRevision({
    revision: approvedOf(w),
    baseSha: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    pr: null,
  });
}

for (const baseRefName of ["main", "other"]) {
  for (const state of ["OPEN", "MERGED"]) {
    test(`merge refuses exact-head ${state} PR targeting ${baseRefName}`, () => {
      const w = world();
      current(w);
      fakeGh.reply([
        savedListing(boundState(w, approvedOf(w))),
        prView({
          headRefOid: w.sha,
          baseRefName,
          state,
          mergeCommit: { oid: MERGE_COMMIT },
        }),
      ]);
      assert.throws(
        () => merge(w.cfg, request(w), confirmationClock()),
        TARGET_REFUSAL,
      );
      assert.deepEqual(writes(), []);
    });
  }
}

test("merge rechecks the actual target after revision and base prechecks before mutation", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha, baseRefName: "main" }),
  ]);
  assert.throws(
    () => merge(w.cfg, request(w), confirmationClock()),
    TARGET_REFUSAL,
  );
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
    approvalReply(w),
    ...mergeAuthority(boundState(w, approvedOf(w))),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      baseRefName: "main",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  const result = merge(w.cfg, request(w), confirmationClock());
  assert.equal(result.merged, false);
  assert.ok("reason" in result);
  assert.match(result.reason, TARGET_REFUSAL);
  assert.equal(writes().filter((args) => !args.includes("PATCH")).length, 1);
  assert.equal(writes()[0]?.[1], "repos/o/r/pulls/50/reviews");
  assert.equal(
    writes().some((args) => args[1] === "repos/o/r/merges"),
    false,
  );
  assert.equal(
    sh(`git --git-dir=${w.root}/origin.git rev-parse integration`),
    w.sha,
  );
});
