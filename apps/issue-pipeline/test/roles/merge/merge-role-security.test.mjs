// @ts-check
// The security review of the merged result through a fake RoleContext: a
// finding saves its receipt and stops the issue with its category, never
// finishing, and the same rejected revision stops again with no session; a
// review the revision moved under is discarded; the receipt binds exactly
// what merged, so another revision is reviewed again; and failures never
// pass for a review.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  opNames,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_MERGE,
  CODE_MERGED,
  finding,
  MERGED_REVISION,
  merging,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";

const CATEGORIES = /** @type {const} */ ([
  "user-harm",
  "rights",
  "financial-harm",
  "abuse-risk",
]);
const STAYS_MERGED = /merged code stays merged and the issue is not completed/u;
const STOPPED_COMMENT =
  /^## Security review of the merged result: stopped \(user-harm\)/u;
const NOT_THE_MERGE = /prepare-review read f{40}, not the merge commit e{40}/u;
const DISCARDED = /moved during the security review/u;

/** @type {import("../../../src/state.ts").Security} */
const REJECTION = {
  revision: MERGED_REVISION,
  commentId: COMMENT_ID,
  finding: { category: "rights", reason: "src/chat.ts:3 exports chats" },
};

/** @param {Parameters<typeof opNames>[0]} calls */
function finishedOps(calls) {
  return opNames(calls).filter((name) => name === "finish");
}

test("a finding in any category saves its receipt and stops with that category, never finishing", async () => {
  const runs = CATEGORIES.map((category) =>
    merging({ sessions: [finding(category)] }),
  );
  const ends = await Promise.all(runs.map(({ ctx }) => mergeRole(ctx)));
  for (const [index, end] of ends.entries()) {
    const category = CATEGORIES[index];
    const { calls } = runs[index] ?? { calls: [] };
    assert.equal(endCode(end), category);
    assert.ok(end.kind === "stop");
    assert.match(end.reason, STAYS_MERGED);
    assert.equal(end.state.stage, "merge");
    assert.deepEqual(end.state.merged, MERGED_REVISION);
    assert.deepEqual(end.state.security?.revision, MERGED_REVISION);
    assert.equal(end.state.security?.finding?.category, category);
    assert.deepEqual(savesOf(calls).at(-1)?.security, end.state.security);
    assert.deepEqual(finishedOps(calls), []);
  }
  assert.match(postsOf(runs[0]?.calls ?? [])[0]?.body ?? "", STOPPED_COMMENT);
});

test("the same rejected revision stops again with no session, prepare or finish", async () => {
  const { ctx, calls } = fakeContext({
    stage: "merge",
    state: {
      ...merging().ctx.state,
      ...CODE_MERGED,
      merged: MERGED_REVISION,
      security: REJECTION,
    },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const end = await mergeRole(ctx);
  assert.equal(endCode(end), "rights");
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(savesOf(calls).length, 0);
});

test("a rejection of another revision is no receipt for this one: the merged result is reviewed afresh", async () => {
  const { ctx, calls } = merging({
    state: {
      security: {
        ...REJECTION,
        revision: { ...MERGED_REVISION, inputs: NEW_INPUTS },
      },
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 1);
  assert.equal(state.stage, "done");
  assert.equal(state.security?.finding, null);
});

test("a revision that moved during the review discards it: nothing is saved as a receipt or finished", async () => {
  const { ctx, calls } = merging({
    ops: {
      "current-revision": [
        current(),
        current(),
        AFTER_MERGE,
        current({ code: MOVED }, AFTER_MERGE.pr),
      ],
    },
  });
  const end = await mergeRole(ctx);
  assert.ok(end.kind === "wait");
  assert.match(end.reason, DISCARDED);
  assert.equal(end.state.security, null);
  assert.equal(postsOf(calls).length, 0);
  assert.ok(savesOf(calls).every((saved) => saved.security === null));
  assert.deepEqual(finishedOps(calls), []);
});

test("inputs that changed during the review send the issue to the author, never finishing", async () => {
  const { ctx, calls } = merging({
    ops: {
      "current-revision": [
        current(),
        current(),
        AFTER_MERGE,
        current({ code: MERGE_COMMIT, inputs: NEW_INPUTS }, AFTER_MERGE.pr),
      ],
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.deepEqual(finishedOps(calls), []);
});

test("a review prepared at another head than the merge commit stops with no session", async () => {
  const { ctx, calls } = merging({
    ops: { "prepare-review": [{ ...PREPARED_MERGED, headSha: MOVED }] },
  });
  const end = await mergeRole(ctx);
  assert.equal(endCode(end), "error");
  assert.ok(end.kind === "stop");
  assert.match(end.reason, NOT_THE_MERGE);
  assert.equal(sessionsOf(calls).length, 0);
  assert.deepEqual(finishedOps(calls), []);
});

test("a failed review stops with error and a transient one defers, neither finishing", async () => {
  const failed = merging({
    sessions: [{ ok: false, transient: false, error: "no reply" }],
  });
  assert.equal(endCode(await mergeRole(failed.ctx)), "error");
  const transient = merging({
    sessions: [{ ok: false, transient: true, error: "429" }],
  });
  assert.equal((await mergeRole(transient.ctx)).kind, "deferred");
  for (const { calls } of [failed, transient]) {
    assert.deepEqual(finishedOps(calls), []);
    assert.ok(savesOf(calls).every((saved) => saved.security === null));
  }
});

test("a done completion with a saved rejection stops again, never finishing", async () => {
  const { ctx, calls } = fakeContext({
    stage: "merge",
    state: {
      ...merging().ctx.state,
      stage: "done",
      merged: MERGED_REVISION,
      security: REJECTION,
    },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  assert.equal(endCode(await mergeRole(ctx)), "rights");
  assert.deepEqual(opNames(calls), ["current-revision"]);
});
