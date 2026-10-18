// @ts-check
// The merge role through a fake RoleContext: no model session ever; a merge
// only of the exact approved revision, read fresh right before it, with the
// merge queue and the head match passed to the merge op; its receipt saved
// before the publish; and changed inputs to the author, a changed head to
// review, before or after the merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MERGED_PR,
  merging,
  mutationsOf,
  QUEUE,
} from "./merge-role-test-kit.mjs";
import {
  callNames,
  endCode,
  firstPayload,
  freshBefore,
  opNames,
  savesOf,
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
  mergeRole,
  NEW_INPUTS,
  REVISION,
  WIKI,
} from "./reviewer-and-merge-role-kit.mjs";

const UNREADABLE_REPLY = /reply is not what the role reads/u;

test("an approved revision merges with its head matched, then publishes exactly the reviewed wiki", async () => {
  const { ctx, calls } = merging();
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, {
    code: MERGE_COMMIT,
    wiki: WIKI,
    inputs: INPUTS,
  });
  const {
    expectedSha,
    revision,
    mergeQueue,
    state: mergedFrom,
  } = firstPayload(calls, "merge");
  assert.equal(expectedSha, HEAD);
  assert.deepEqual(revision, REVISION);
  assert.deepEqual(mergeQueue, QUEUE);
  assert.deepEqual(mergedFrom, ctx.state);
  const publish = firstPayload(calls, "publish");
  const { expectedWiki, revision: published, state: publishing } = publish;
  assert.equal(expectedWiki, WIKI);
  assert.deepEqual(published, REVISION);
  assert.ok(freshBefore(calls, "merge"));
  assert.ok(freshBefore(calls, "publish"));
  const saves = savesOf(calls);
  assert.equal(saves.length, 2);
  // The receipt, saved before the publish: still at merge, the merge commit
  // with the approved wiki and inputs, and the approval's revision kept as
  // the pre-merge head the merge matched.
  assert.equal(saves[0]?.stage, "merge");
  assert.deepEqual(saves[0]?.merged, {
    code: MERGE_COMMIT,
    wiki: WIKI,
    inputs: INPUTS,
  });
  assert.deepEqual(saves[0]?.review.revision, REVISION);
  assert.equal(saves[0]?.review.verdict, "approve");
  assert.ok(saves[0]?.log.at(-1)?.includes(MERGE_COMMIT));
  assert.deepEqual(publishing, saves[0]);
  // The completion, saved before the finish op labels and closes the issue.
  const order = callNames(calls);
  assert.ok(order.indexOf("save") < order.indexOf("publish"));
  assert.ok(order.lastIndexOf("save") < order.indexOf("finish-wiki"));
  assert.equal(saves[1]?.stage, "done");
  const { state: finished } = firstPayload(calls, "finish-wiki");
  assert.deepEqual(finished, saves[1]);
});

test("no approval for the current revision goes to review without a mutation", async () => {
  const reviews = [
    approvedReview({ revision: { ...REVISION, code: MOVED } }),
    approvedReview({ revision: { ...REVISION, wiki: MOVED } }),
    approvedReview({ verdict: null }),
    approvedReview({ verdict: "changes" }),
  ];
  const runs = reviews.map((review) => merging({ state: { review } }));
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    const state = stateOf(end, "next");
    assert.equal(state.stage, "review");
    assert.equal(state.review.verdict, null);
    assert.deepEqual(state.review.revision, reviews[index]?.revision);
    assert.deepEqual(opNames(runs[index]?.calls ?? []), ["current-revision"]);
  }
});

test("inputs the Gherkin predates go to the author before anything merges", async () => {
  const { ctx, calls } = merging({
    gherkin: gherkinComment({ inputs: NEW_INPUTS }),
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.resumeStage, "review");
  assert.deepEqual(mutationsOf(calls), []);
});

test("inputs that change after the checks hold the merge back", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ inputs: NEW_INPUTS })] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.deepEqual(mutationsOf(calls), ["wiki-sync"]);
});

test("a head that changes after the checks goes to review, not to merge", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ code: MOVED })] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.ok(!opNames(calls).includes("merge"));
});

test("a queued merge waits at merge, publishing nothing", async () => {
  const { ctx, calls } = merging({
    ops: { merge: [{ merged: false, reason: "queued", waitingFor: QUEUE[0] }] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.stage, "merge");
  assert.deepEqual(mutationsOf(calls), ["wiki-sync", "merge"]);
});

test("GitHub's refusal stops with merge-refused; a merged reply with no merge commit is an error", async () => {
  const refused = merging({
    ops: { merge: [{ merged: false, reason: "merge refused: protected" }] },
  });
  assert.equal(endCode(await mergeRole(refused.ctx)), "merge-refused");
  const blind = merging({ ops: { merge: [{ merged: true, byHand: true }] } });
  await assert.rejects(mergeRole(blind.ctx), {
    name: "OpsFailure",
    op: "merge",
    message: UNREADABLE_REPLY,
  });
  assert.ok(!opNames(blind.calls).includes("publish"));
  assert.equal(savesOf(blind.calls).length, 0);
});

test("after its own merge, a wiki that moved waits for review instead of publishing", async () => {
  const { ctx, calls } = merging({
    ops: {
      "current-revision": [
        current(),
        current(),
        current({ code: MERGE_COMMIT, wiki: MOVED }, MERGED_PR),
      ],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.ok(!opNames(calls).includes("publish"));
  assert.ok(savesOf(calls)[0]?.log.at(-1)?.includes(MERGE_COMMIT));
});

test("after its own merge, GitHub must confirm the receipt; only the exact pre-merge head may stand for the code", async () => {
  const afters = [
    current({ code: MERGE_COMMIT }, { ...MERGED_PR, mergeCommit: MOVED }),
    current({ code: MERGE_COMMIT }, { ...MERGED_PR, state: "OPEN" }),
    current({ code: MOVED }, MERGED_PR),
  ];
  const runs = afters.map((after) =>
    merging({ ops: { "current-revision": [current(), current(), after] } }),
  );
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    const state = stateOf(end, "next");
    assert.equal(state.stage, "review");
    assert.equal(state.review.verdict, null);
    const names = opNames(runs[index]?.calls ?? []);
    assert.ok(!names.includes("publish"));
    assert.ok(!names.includes("finish-wiki"));
  }
  const premerge = merging({
    ops: { "current-revision": [current(), current(), current({}, MERGED_PR)] },
  });
  const done = stateOf(await mergeRole(premerge.ctx), "next");
  assert.equal(done.stage, "done");
  assert.deepEqual(done.merged, {
    code: MERGE_COMMIT,
    wiki: WIKI,
    inputs: INPUTS,
  });
});
