// @ts-check
// The reviewer role's revision checks through a fake RoleContext: a head or
// inputs change before or during the session voids the verdict and posts
// nothing, a stale Gherkin goes to the author, the wiki-only review after
// the code merged binds the merge commit, and failures never pass for a
// review.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  firstPayload,
  opNames,
  postsOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  approvedReview,
  current,
  gherkinComment,
  HEAD,
  INPUTS,
  MERGE_COMMIT,
  MOVED,
  NEW_INPUTS,
  PR,
  reviewerRole,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";
import { PREPARED, review } from "./reviewer-role-test-kit.mjs";

const UNREADABLE_REPLY = /reply is not what the role reads/u;

test("a head that moved during the session discards the verdict", async () => {
  const { ctx, calls } = review({
    state: { review: approvedReview() },
    after: current({ wiki: MOVED }),
  });
  const state = stateOf(await reviewerRole(ctx), "wait");
  assert.equal(state.review.verdict, null);
  assert.equal(postsOf(calls).length, 0);
});

test("inputs that changed during the session send the issue to the author", async () => {
  const { ctx, calls } = review({ after: current({ inputs: NEW_INPUTS }) });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.equal(postsOf(calls).length, 0);
});

test("a Gherkin older than the inputs goes to the author before any review", async () => {
  const { ctx, calls } = review({
    gherkin: gherkinComment({ inputs: NEW_INPUTS }),
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
});

test("a diff prepared at another head than the revision is not reviewed, and voids the verdict", async () => {
  const { ctx, calls } = review({
    state: { review: approvedReview() },
    prepared: { ...PREPARED, headSha: MOVED },
  });
  const state = stateOf(await reviewerRole(ctx), "wait");
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(postsOf(calls).length, 0);
  assert.equal(state.review.verdict, null);
});

test("after the code merged, the wiki-only review binds the merge commit", async () => {
  const merged = current(
    { code: MERGE_COMMIT },
    { number: PR, state: "MERGED", mergeCommit: MERGE_COMMIT },
  );
  const { ctx, calls } = review({
    state: {
      codeMerged: { pr: PR, sha: MERGE_COMMIT },
      verifiedSha: MERGE_COMMIT,
    },
    before: merged,
    after: merged,
    prepared: { ...PREPARED, headSha: MERGE_COMMIT },
  });
  const state = stateOf(await reviewerRole(ctx), "next");
  const { codeMerged } = firstPayload(calls, "prepare-review");
  assert.deepEqual(codeMerged, {
    pr: PR,
    sha: MERGE_COMMIT,
  });
  assert.ok(
    sessionsOf(calls)[0]?.task.includes(`merged as \`${MERGE_COMMIT}\``),
  );
  assert.equal(state.stage, "merge");
  assert.deepEqual(state.review.revision, {
    code: MERGE_COMMIT,
    wiki: WIKI,
    inputs: INPUTS,
  });
});

test("a code merge GitHub doesn't confirm stops before any review", async () => {
  const { ctx, calls } = review({
    state: { codeMerged: { pr: PR, sha: MERGE_COMMIT } },
    before: current({ code: MERGE_COMMIT }),
  });
  const end = await reviewerRole(ctx);
  stateOf(end, "stop");
  assert.equal(endCode(end), "error");
  assert.equal(sessionsOf(calls).length, 0);
});

test("a change that lives only in the wiki is reviewed on the issue", async () => {
  const { ctx, calls } = review({
    state: { pr: null, flows: { code: false, wiki: true } },
    before: current({}, null),
    after: current({}, null),
  });
  stateOf(await reviewerRole(ctx), "next");
  assert.equal(postsOf(calls)[0]?.on, "issue");
  assert.equal(postsOf(calls)[0]?.key, "review-r1");
});

test("a failed session stops with error, and a transient one defers", async () => {
  const failedEnd = await reviewerRole(
    review({ result: { ok: false, transient: false, error: "bad reply" } }).ctx,
  );
  assert.equal(endCode(failedEnd), "error");
  const deferred = await reviewerRole(
    review({ result: { ok: false, transient: true, error: "429" } }).ctx,
  );
  assert.equal(deferred.kind, "deferred");
});

test("an op reply of an unexpected shape is an error, not a review", async () => {
  const { ctx, calls } = review({ before: { revision: { code: HEAD } } });
  await assert.rejects(reviewerRole(ctx), {
    name: "OpsFailure",
    op: "current-revision",
    message: UNREADABLE_REPLY,
  });
  assert.equal(sessionsOf(calls).length, 0);
});
