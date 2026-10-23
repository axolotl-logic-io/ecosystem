// @ts-check
// The merge role's end through a fake RoleContext: a code merge before this
// job without its own receipt stops with no postmerge suite, review or
// completion (#185); the completion saved before the finish op; and the
// finish reconciliation of a saved completion, which confirms actual M
// read-only before finishing once its security receipt clears exactly what
// merged, never another merge.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  firstPayload,
  opNames,
  opPayloads,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
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
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_MERGE,
  CODE_MERGED,
  CONFIRMED,
  FINISHED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  PREPARED_MERGED,
  QUEUE,
} from "./merge-role-test-kit.mjs";

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

const POSTMERGE_OPS = ["verify", "prepare-review", "confirm-merged", "merge"];
// What ran after an earlier merge without this job's receipt: no postmerge
// op, model or writer may run.
/** @param {Parameters<typeof opNames>[0]} calls */
function afterEarlierMergeRan(calls) {
  return {
    ops: opNames(calls).filter((name) => POSTMERGE_OPS.includes(name)),
    mutations: mutationsOf(calls),
    sessions: sessionsOf(calls).length,
  };
}
const NOTHING_RAN = { ops: [], mutations: [], sessions: 0 };

test("after an external code merge, the merge commit is neither verified, reviewed for security nor completed", async () => {
  const { ctx, calls } = merging({
    state: {
      ...CODE_MERGED,
      verifiedSha: HEAD,
      hardened: MERGED_REVISION,
    },
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_MERGE, AFTER_MERGE],
      "prepare-review": [PREPARED_MERGED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(ctx), "stop");
  assert.notEqual(state.stage, "done");
  assert.deepEqual(state.codeMerged, CODE_MERGED.codeMerged);
  assert.deepEqual(state.hardened, MERGED_REVISION);
  assert.equal(state.security, null);
  assert.deepEqual(afterEarlierMergeRan(calls), NOTHING_RAN);
});

test("a code merge without hardening of the merge commit or GitHub's confirmation stops, never returning to review", async () => {
  const stale = merging({
    state: { ...CODE_MERGED },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const stopped = stateOf(await mergeRole(stale.ctx), "stop");
  assert.deepEqual(stopped.codeMerged, CODE_MERGED.codeMerged);
  assert.deepEqual(afterEarlierMergeRan(stale.calls), NOTHING_RAN);
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

test("a saved completion whose finish crashed confirms M read-only before finishing again", async () => {
  const crashed = merging({
    ops: { finish: [() => Promise.reject(new Error("gh: network"))] },
  });
  await assert.rejects(mergeRole(crashed.ctx), NETWORK);
  const saved = savesOf(crashed.calls).at(-1);
  assert.ok(saved !== undefined);
  assert.equal(saved.stage, "done");
  assert.deepEqual(saved.merged, MERGED_REVISION);
  const replay = fakeContext({
    stage: "merge",
    state: saved,
    mergeQueue: QUEUE,
    ops: {
      "current-revision": [AFTER_MERGE],
      "confirm-merged": [CONFIRMED],
      finish: [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  const state = stateOf(await mergeRole(replay.ctx), "next");
  assert.deepEqual(state, saved);
  assert.deepEqual(
    checksBeforeFinish(replay.calls),
    confirmedOnly(replay.ctx.issue),
  );
  assert.deepEqual(mutationsOf(replay.calls), ["finish"]);
  const { state: finished } = firstPayload(replay.calls, "finish");
  assert.deepEqual(finished, saved);
  assert.equal(sessionsOf(replay.calls).length, 0);
  assert.deepEqual(savesOf(replay.calls), []);
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
  assert.deepEqual(opNames(calls), ["current-revision", "finish"]);
});

test("a completion saved with a legacy wiki head and no security review of it stops for reconciliation, reviewing and finishing nothing", async () => {
  const merged = { ...MERGED_REVISION, wiki: MOVED };
  const { ctx, calls } = merging({
    state: { ...DONE, merged, security: null },
    ops: { "current-revision": [current({ code: MERGE_COMMIT }, MERGED_PR)] },
  });
  assert.equal(endCode(await mergeRole(ctx)), "error");
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
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

// The read-only confirmation of M and any postmerge suite before finishing.
/** @param {Parameters<typeof opNames>[0]} calls */
function checksBeforeFinish(calls) {
  const names = opNames(calls);
  return {
    confirmedFirst: names.indexOf("confirm-merged") < names.indexOf("finish"),
    confirmations: opPayloads(calls, "confirm-merged"),
    verifications: opPayloads(calls, "verify"),
  };
}
/** @param {number} issue */
function confirmedOnly(issue) {
  return {
    confirmedFirst: true,
    confirmations: [{ number: issue, ...CODE_MERGED }],
    verifications: [],
  };
}

// A saved completion whose finish op refuses for `reason`.
/** @param {string} reason */
function refusedFinish(reason) {
  return merging({
    state: DONE,
    ops: {
      "current-revision": [AFTER_MERGE],
      finish: [{ finished: false, reason, detail: "why" }],
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
  assert.deepEqual(
    checksBeforeFinish(refused.calls),
    confirmedOnly(refused.ctx.issue),
  );
  assert.deepEqual(mutationsOf(refused.calls), ["finish"]);
  assert.equal(sessionsOf(refused.calls).length, 0);
  assert.deepEqual(savesOf(refused.calls), []);
});

test("a finish op reply outside its schema fails as an op, so the job stops instead of crashing", async () => {
  const { ctx } = merging({
    state: DONE,
    ops: { "current-revision": [AFTER_MERGE], finish: [{}] },
  });
  await assert.rejects(mergeRole(ctx), {
    name: "OpsFailure",
    op: "finish",
  });
});

test("a merge receipt for another legacy wiki head cannot resume the own merge: it stops, never reviewing or finishing", async () => {
  const { ctx, calls } = merging({
    state: {
      ...CODE_MERGED,
      merged: { code: MERGE_COMMIT, wiki: MOVED, inputs: INPUTS },
    },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const state = stateOf(await mergeRole(ctx), "stop");
  assert.notEqual(state.stage, "review");
  assert.deepEqual(state.codeMerged, CODE_MERGED.codeMerged);
  assert.deepEqual(afterEarlierMergeRan(calls), NOTHING_RAN);
});
