// @ts-check
// The merge role's end through a fake RoleContext: the publish when no code
// is left to merge (merged before this job, or a change that lives only in
// the wiki), the completion saved before the finish op, a refused publish
// that completes nothing, and the finish reconciliation of a saved
// completion, which runs only the finish op, never a merge or a publish.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTER_MERGE,
  CODE_MERGED,
  FINISHED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  QUEUE,
} from "./merge-role-test-kit.mjs";
import {
  endCode,
  firstPayload,
  freshBefore,
  opNames,
  opPayloads,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  approvedReview,
  current,
  fakeContext,
  gherkinComment,
  HEAD,
  INPUTS,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  REVISION,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";

const NETWORK = /network/u;
const DONE = {
  stage: /** @type {const} */ ("done"),
  merged: MERGED_REVISION,
  review: approvedReview(),
};

test("a finish that fails leaves the completion saved for a retry", async () => {
  const { ctx, calls } = merging({
    ops: { "finish-wiki": [() => Promise.reject(new Error("gh: network"))] },
  });
  await assert.rejects(mergeRole(ctx), NETWORK);
  const saved = savesOf(calls).at(-1);
  assert.equal(saved?.stage, "done");
  assert.deepEqual(saved?.merged, MERGED_REVISION);
});

test("a refused publish waits and records no completion", async () => {
  const { ctx, calls } = merging({
    ops: { publish: [{ published: false, reason: "wiki-behind" }] },
  });
  stateOf(await mergeRole(ctx), "wait");
  assert.ok(!opNames(calls).includes("finish-wiki"));
  assert.ok(savesOf(calls).every((saved) => saved.stage !== "done"));
});

test("after a confirmed code merge, the merge commit is verified and only the reviewed wiki checked and published", async () => {
  const { ctx, calls } = merging({
    state: {
      ...CODE_MERGED,
      verifiedSha: HEAD,
      review: approvedReview({ revision: MERGED_REVISION }),
    },
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_MERGE],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, MERGED_REVISION);
  assert.ok(!opNames(calls).includes("merge"));
  assert.deepEqual(opPayloads(calls, "verify")[0], CODE_MERGED);
  const { expectedWiki } = firstPayload(calls, "publish");
  assert.equal(expectedWiki, WIKI);
  assert.ok(freshBefore(calls, "publish"));
});

test("a code merge needs a review of the merge commit, and GitHub's confirmation", async () => {
  const stale = merging({
    state: { ...CODE_MERGED },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const reviewed = stateOf(await mergeRole(stale.ctx), "next");
  assert.equal(reviewed.stage, "review");
  assert.deepEqual(mutationsOf(stale.calls), []);
  const unconfirmed = merging({
    state: {
      ...CODE_MERGED,
      review: approvedReview({ revision: MERGED_REVISION }),
    },
    ops: { "current-revision": [current({ code: MERGE_COMMIT })] },
  });
  assert.equal(endCode(await mergeRole(unconfirmed.ctx)), "error");
  assert.deepEqual(mutationsOf(unconfirmed.calls), []);
});

test("a change that lives only in the wiki publishes with no code merge and no PR", async () => {
  const { ctx, calls } = merging({
    state: { pr: null, flows: { code: false, wiki: true } },
    ops: { "current-revision": [current({}, null), current({}, null)] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, { ...REVISION, code: null });
  assert.ok(!opNames(calls).includes("merge"));
  assert.ok(freshBefore(calls, "publish"));
});

test("a saved completion whose finish crashed only runs the finish op again", async () => {
  const crashed = merging({
    ops: { "finish-wiki": [() => Promise.reject(new Error("gh: network"))] },
  });
  await assert.rejects(mergeRole(crashed.ctx), NETWORK);
  const saved = savesOf(crashed.calls).at(-1);
  assert.ok(saved !== undefined);
  const replay = fakeContext({
    stage: "merge",
    state: saved,
    mergeQueue: QUEUE,
    ops: { "current-revision": [AFTER_MERGE], "finish-wiki": [FINISHED] },
  });
  const state = stateOf(await mergeRole(replay.ctx), "next");
  assert.deepEqual(state, saved);
  assert.deepEqual(opNames(replay.calls), ["current-revision", "finish-wiki"]);
  const { state: finished } = firstPayload(replay.calls, "finish-wiki");
  assert.deepEqual(finished, saved);
  assert.equal(sessionsOf(replay.calls).length, 0);
  assert.equal(savesOf(replay.calls).length, 0);
});

test("a completion of a change that lives only in the wiki finishes with no PR", async () => {
  const { ctx, calls } = merging({
    state: {
      ...DONE,
      pr: null,
      flows: { code: false, wiki: true },
      merged: { ...MERGED_REVISION, code: null },
    },
    ops: { "current-revision": [current({ code: null }, null)] },
  });
  stateOf(await mergeRole(ctx), "next");
  assert.deepEqual(opNames(calls), ["current-revision", "finish-wiki"]);
});

test("a completion is not finished on new inputs or a merge GitHub doesn't confirm", async () => {
  const changed = merging({
    state: DONE,
    ops: {
      "current-revision": [
        current({ code: MERGE_COMMIT, inputs: NEW_INPUTS }, MERGED_PR),
      ],
    },
    gherkin: gherkinComment({ inputs: NEW_INPUTS }),
  });
  const author = stateOf(await mergeRole(changed.ctx), "next");
  assert.equal(author.stage, "author");
  assert.deepEqual(opNames(changed.calls), ["current-revision"]);
  const unconfirmed = merging({
    state: DONE,
    ops: {
      "current-revision": [
        current({ code: MERGE_COMMIT }, { ...MERGED_PR, mergeCommit: MOVED }),
      ],
    },
  });
  assert.equal(endCode(await mergeRole(unconfirmed.ctx)), "error");
  assert.deepEqual(opNames(unconfirmed.calls), ["current-revision"]);
});

// A saved completion whose finish op refuses for `reason`.
/** @param {string} reason */
function refusedFinish(reason) {
  return merging({
    state: DONE,
    ops: {
      "current-revision": [AFTER_MERGE],
      "finish-wiki": [{ finished: false, reason, detail: "why" }],
    },
  });
}

test("a completion the finish op refuses for new inputs goes to the author", async () => {
  const { ctx } = refusedFinish("inputs-changed");
  const author = stateOf(await mergeRole(ctx), "next");
  assert.equal(author.stage, "author");
});

test("a completion whose published wiki the finish op can't prove stops, never done", async () => {
  const unpublished = refusedFinish("wiki-unpublished");
  assert.equal(endCode(await mergeRole(unpublished.ctx)), "error");
  assert.deepEqual(opNames(unpublished.calls), [
    "current-revision",
    "finish-wiki",
  ]);
  assert.equal(savesOf(unpublished.calls).length, 0);
  const changed = refusedFinish("wiki-changed");
  assert.equal(endCode(await mergeRole(changed.ctx)), "error");
  assert.equal(savesOf(changed.calls).length, 0);
});

test("a finish op reply outside its schema fails as an op, so the job stops instead of crashing", async () => {
  const { ctx } = merging({
    state: DONE,
    ops: { "current-revision": [AFTER_MERGE], "finish-wiki": [{}] },
  });
  await assert.rejects(mergeRole(ctx), {
    name: "OpsFailure",
    op: "finish-wiki",
  });
});

test("a receipt saved at merge is not a completion: the next merge job reviews, never finishes", async () => {
  const { ctx, calls } = merging({
    state: {
      ...CODE_MERGED,
      merged: { code: MERGE_COMMIT, wiki: WIKI, inputs: INPUTS },
      review: approvedReview(),
    },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.equal(state.review.verdict, null);
  assert.deepEqual(state.review.revision, REVISION);
  assert.deepEqual(mutationsOf(calls), []);
});
