// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalReply } from "./merge-op-fixtures.mjs";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  ISSUE,
  PR,
  prView,
  savedListing,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { approvePr } = await import("../src/ops/pr-approval.ts");
const { merge } = await import("../src/ops/merge.ts");
const INVALID_APPROVAL = /approval|Invalid|APPROVED/u;

test("approval uses the review account and immutable checked head", () => {
  const w = world();
  fakeGh.reply([approvalReply(w)]);
  approvePr(w.cfg, PR, w.sha);
  assert.deepEqual(writes(), [
    [
      "api",
      "repos/o/r/pulls/50/reviews",
      "--method",
      "POST",
      "-f",
      "event=APPROVE",
      "-f",
      `commit_id=${w.sha}`,
      "--jq",
      "{state, commit: .commit_id, login: .user.login}",
    ],
  ]);
});

for (const result of [
  { state: "APPROVED", commit: "wrong", login: "bot" },
  { state: "APPROVED", commit: "head", login: "other" },
  { state: "PENDING", commit: "head", login: "bot" },
  {},
]) {
  test(`invalid approval refuses before branch merge: ${JSON.stringify(result)}`, () => {
    const w = world();
    const revision = { code: w.sha, inputs: "inputs-1" };
    setCurrentRevision({ revision, baseSha: "base", pr: null });
    const response = { ...result };
    if (response.commit === "head") {
      response.commit = w.sha;
    }
    fakeGh.reply([
      savedListing(approvedState(revision)),
      prView({ headRefOid: w.sha }),
      prView({ headRefOid: w.sha }),
      { ...approvalReply(w), stdout: JSON.stringify(response) },
    ]);
    assert.throws(
      () =>
        merge(w.cfg, {
          number: ISSUE,
          state: approvedState(revision),
          expectedSha: w.sha,
          revision,
        }),
      INVALID_APPROVAL,
    );
    assert.equal(writes().length, 1);
    assert.equal(writes()[0]?.[1], "repos/o/r/pulls/50/reviews");
  });
}

test("failed approval never attempts a branch merge", () => {
  const w = world();
  const revision = { code: w.sha, inputs: "inputs-1" };
  setCurrentRevision({ revision, baseSha: "base", pr: null });
  fakeGh.reply([
    savedListing(approvedState(revision)),
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha }),
    { ...approvalReply(w), code: 1, stderr: "approval refused" },
  ]);
  assert.throws(
    () =>
      merge(w.cfg, {
        number: ISSUE,
        state: approvedState(revision),
        expectedSha: w.sha,
        revision,
      }),
    INVALID_APPROVAL,
  );
  assert.equal(writes().length, 1);
  assert.equal(writes()[0]?.[1], "repos/o/r/pulls/50/reviews");
});
