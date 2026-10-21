// @ts-check
// The merge role's end through a fake RoleContext: the security review and
// completion when the code merged before this job, the completion saved
// before the finish op, and the finish reconciliation of a saved
// completion, which rechecks actual M before finishing once its security
// receipt clears exactly what merged, never another merge.
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
  callNames,
  checksBefore,
  endCode,
  firstPayload,
  freshBefore,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  gherkinComment,
  HEAD,
  INPUTS,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
} from "./reviewer-and-merge-role-kit.mjs";

const NETWORK = /network/u;
const CLEARED = {
  revision: MERGED_REVISION,
  commentId: COMMENT_ID,
  finding: null,
};
const DONE = {
  stage: /** @type {const} */ ("done"),
  merged: MERGED_REVISION,
  security: CLEARED,
};

// What runs between the security review session and the finish op: the
// revision read fresh after the session, the receipt's comment and its save,
// the completion's save, and nothing that could move a head.
/** @param {Parameters<typeof callNames>[0]} calls */
function betweenSessionAndFinish(calls) {
  const names = callNames(calls);
  return names.slice(
    names.indexOf("session") + 1,
    names.indexOf("finish-wiki"),
  );
}

test("a finish that fails leaves the completion saved for a retry", async () => {
  const { ctx, calls } = merging({
    ops: { "finish-wiki": [() => Promise.reject(new Error("gh: network"))] },
  });
  await assert.rejects(mergeRole(ctx), NETWORK);
  const saved = savesOf(calls).at(-1);
  assert.equal(saved?.stage, "done");
  assert.deepEqual(saved?.merged, MERGED_REVISION);
});

test("after a confirmed code merge, the merge commit is verified, reviewed for security and completed", async () => {
  const { ctx, calls } = merging({
    state: {
      ...CODE_MERGED,
      verifiedSha: HEAD,
      hardened: MERGED_REVISION,
    },
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_MERGE, AFTER_MERGE],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, MERGED_REVISION);
  assert.deepEqual(state.security?.revision, MERGED_REVISION);
  assert.ok(!opNames(calls).includes("merge"));
  const { codeMerged: verifiedMerge } = firstPayload(calls, "verify");
  assert.deepEqual(verifiedMerge, CODE_MERGED.codeMerged);
  const { codeMerged: reviewedMerge } = firstPayload(calls, "prepare-review");
  assert.deepEqual(reviewedMerge, CODE_MERGED.codeMerged);
  assert.ok(freshBefore(calls, "prepare-review"));
  assert.deepEqual(betweenSessionAndFinish(calls), [
    "current-revision",
    "post",
    "save",
    "save",
  ]);
});

test("a code merge needs a hardening of the merge commit, and GitHub's confirmation", async () => {
  const stale = merging({
    state: { ...CODE_MERGED },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const reviewed = stateOf(await mergeRole(stale.ctx), "next");
  assert.equal(reviewed.stage, "review");
  assert.deepEqual(mutationsOf(stale.calls), []);
  const unconfirmed = merging({
    state: { ...CODE_MERGED, hardened: MERGED_REVISION },
    ops: { "current-revision": [current({ code: MERGE_COMMIT })] },
  });
  assert.equal(endCode(await mergeRole(unconfirmed.ctx)), "error");
  assert.deepEqual(mutationsOf(unconfirmed.calls), []);
});

test("a change with no PR and no code merge stops, merging nothing", async () => {
  const { ctx, calls } = merging({
    state: { pr: null },
    ops: { "current-revision": [current({}, null)] },
  });
  assert.equal(endCode(await mergeRole(ctx)), "error");
  assert.deepEqual(mutationsOf(calls), []);
  assert.equal(sessionsOf(calls).length, 0);
});

test("a saved completion whose finish crashed rechecks M before finishing again", async () => {
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
    ops: {
      "current-revision": [AFTER_MERGE],
      "finish-wiki": [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(replay.ctx), "next");
  assert.deepEqual(state, saved);
  const checks = checksBefore(replay.calls, "finish-wiki");
  assert.deepEqual(checks.verify, { number: replay.ctx.issue, ...CODE_MERGED });
  assert.deepEqual(mutationsOf(replay.calls), ["finish-wiki"]);
  const { state: finished } = firstPayload(replay.calls, "finish-wiki");
  assert.deepEqual(finished, saved);
  assert.equal(sessionsOf(replay.calls).length, 0);
  assert.deepEqual(savesOf(replay.calls), [saved]);
});

test("an older completion with no code merge finishes with no PR", async () => {
  const { ctx, calls } = merging({
    state: {
      ...DONE,
      pr: null,
      flows: { code: false },
      merged: { ...MERGED_REVISION, code: null },
      security: {
        ...CLEARED,
        revision: { ...MERGED_REVISION, code: null },
      },
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

test("a completion the finish op refuses for anything but new inputs stops, never done", async () => {
  const refused = refusedFinish("security");
  assert.equal(endCode(await mergeRole(refused.ctx)), "error");
  const checks = checksBefore(refused.calls, "finish-wiki");
  assert.deepEqual(checks.verify, {
    number: refused.ctx.issue,
    ...CODE_MERGED,
  });
  assert.deepEqual(mutationsOf(refused.calls), ["finish-wiki"]);
  assert.equal(sessionsOf(refused.calls).length, 0);
  assert.equal(savesOf(refused.calls).length, 1);
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

test("a merge receipt for another wiki cannot resume the own merge: it returns to review, never finishing", async () => {
  const { ctx, calls } = merging({
    state: {
      ...CODE_MERGED,
      merged: { code: MERGE_COMMIT, wiki: MOVED, inputs: INPUTS },
    },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.equal(state.hardened, null);
  assert.deepEqual(mutationsOf(calls), []);
  assert.equal(sessionsOf(calls).length, 0);
});
