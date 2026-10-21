// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./fake-ops-publish-revision.mjs";
import { approvalReply } from "./merge-op-fixtures.mjs";
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

const { approvePr } = await import("../../src/ops/pr-approval.ts");
const { merge } = await import("../../src/ops/merge.ts");
const APPROVAL_REFUSED = /approval refused/u;
const INVALID_APPROVAL =
  /PR approval does not match the review account and head/u;

test("approval uses the review account and immutable checked head", () => {
  const w = world();
  fakeGh.reply([approvalReply(w)]);
  approvePr(w.cfg, PR, w.sha);
  const review = writes().find((call) =>
    call.includes(`repos/o/r/pulls/${PR}/reviews`),
  );
  assert.ok(review);
  assert.ok(review.includes("POST"));
  assert.ok(review.includes("event=APPROVE"));
  assert.ok(review.includes(`commit_id=${w.sha}`));
  assert.equal(
    fakeGh
      .authenticatedCalls()
      .find(({ args }) => args.includes(`repos/o/r/pulls/${PR}/reviews`))
      ?.identity,
    "merge",
  );
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
    /** @type {RegExp | {name: string}} */
    let refusal = { name: "ZodError" };
    if (result.state === "APPROVED") {
      refusal = INVALID_APPROVAL;
    }
    assert.throws(
      () =>
        merge(w.cfg, {
          number: ISSUE,
          state: approvedState(revision),
          expectedSha: w.sha,
          revision,
        }),
      refusal,
    );
    assert.equal(
      writes().some((call) => call.includes("repos/o/r/merges")),
      false,
    );
    assert.ok(
      writes().some((call) => call.includes("repos/o/r/pulls/50/reviews")),
    );
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
    APPROVAL_REFUSED,
  );
  assert.equal(
    writes().some((call) => call.includes("repos/o/r/merges")),
    false,
  );
});
