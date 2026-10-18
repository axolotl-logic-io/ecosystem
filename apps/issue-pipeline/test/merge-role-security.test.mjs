// @ts-check
// The security review of the merged result through a fake RoleContext: a
// finding saves its receipt and stops the issue with its category, never
// publishing or finishing, and the same rejected revision stops again with
// no session; a review the revision moved under is discarded; the receipt
// binds exactly what merged and publishes, so a moved wiki is reviewed
// again; and failures never pass for a review.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTER_MERGE,
  CODE_MERGED,
  FINISHED,
  finding,
  MERGED_REVISION,
  merging,
  NO_FINDING,
  PREPARED_MERGED,
  WIKI_UNCHANGED,
} from "./merge-role-test-kit.mjs";
import {
  endCode,
  opNames,
  postsOf,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const CATEGORIES = /** @type {const} */ ([
  "user-harm",
  "rights",
  "financial-harm",
  "abuse-risk",
]);
const STAYS_MERGED = /merged code stays merged and the wiki is not published/u;
const STOPPED_COMMENT =
  /^## Security review of the merged result: stopped \(user-harm\)/u;
const NOT_THE_MERGE = /prepare-review read f{40}, not the merge commit e{40}/u;
const DISCARDED = /moved during the security review/u;
const SECURITY_REFUSED = /publish was refused \(security\): no review/u;
const AFTER_PUBLISH = ["publish", "finish-wiki"];

/** @type {import("../src/state.ts").Security} */
const REJECTION = {
  revision: MERGED_REVISION,
  commentId: COMMENT_ID,
  finding: { category: "rights", reason: "src/chat.ts:3 exports chats" },
};

/** @param {Parameters<typeof opNames>[0]} calls */
function publishedOrFinished(calls) {
  return opNames(calls).filter((name) => AFTER_PUBLISH.includes(name));
}

test("a finding in any category saves its receipt and stops with that category, never publishing or finishing", async () => {
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
    assert.deepEqual(publishedOrFinished(calls), []);
  }
  assert.match(postsOf(runs[0]?.calls ?? [])[0]?.body ?? "", STOPPED_COMMENT);
});

test("the same rejected revision stops again with no session, prepare or publish", async () => {
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

test("a saved rejection of a change that merged no code stops again for the same wiki", async () => {
  const wikiOnly = { ...MERGED_REVISION, code: null };
  const { ctx, calls } = fakeContext({
    stage: "merge",
    state: {
      ...merging().ctx.state,
      pr: null,
      flows: { code: false, wiki: true },
      security: { ...REJECTION, revision: wikiOnly },
    },
    ops: { "current-revision": [current({}, null)] },
  });
  assert.equal(endCode(await mergeRole(ctx)), "rights");
  assert.equal(sessionsOf(calls).length, 0);
});

test("a rejection of another revision is no receipt for this one: the merged result is reviewed afresh", async () => {
  const { ctx, calls } = merging({
    state: {
      security: {
        ...REJECTION,
        revision: { ...MERGED_REVISION, wiki: MOVED },
      },
    },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 1);
  assert.equal(state.stage, "done");
  assert.equal(state.security?.finding, null);
});

test("a revision that moved during the review discards it: nothing is saved as a receipt or published", async () => {
  const { ctx, calls } = merging({
    ops: {
      "current-revision": [
        current(),
        current(),
        AFTER_MERGE,
        current({ code: MERGE_COMMIT, wiki: MOVED }, AFTER_MERGE.pr),
      ],
    },
  });
  const end = await mergeRole(ctx);
  assert.ok(end.kind === "wait");
  assert.match(end.reason, DISCARDED);
  assert.equal(end.state.security, null);
  assert.equal(postsOf(calls).length, 0);
  assert.ok(savesOf(calls).every((saved) => saved.security === null));
  assert.deepEqual(publishedOrFinished(calls), []);
});

test("inputs that changed during the review send the issue to the author, never publishing", async () => {
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
  assert.deepEqual(publishedOrFinished(calls), []);
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
  assert.deepEqual(publishedOrFinished(calls), []);
});

test("a failed review stops with error and a transient one defers, neither publishing", async () => {
  const failed = merging({
    sessions: [{ ok: false, transient: false, error: "no reply" }],
  });
  assert.equal(endCode(await mergeRole(failed.ctx)), "error");
  const transient = merging({
    sessions: [{ ok: false, transient: true, error: "429" }],
  });
  assert.equal((await mergeRole(transient.ctx)).kind, "deferred");
  for (const { calls } of [failed, transient]) {
    assert.deepEqual(publishedOrFinished(calls), []);
    assert.ok(savesOf(calls).every((saved) => saved.security === null));
  }
});

test("a done completion rechecks M before reviewing missing security or reusing exact clearance", async () => {
  const done = {
    ...merging().ctx.state,
    stage: /** @type {const} */ ("done"),
    merged: MERGED_REVISION,
  };
  const unreviewed = fakeContext({
    stage: "merge",
    state: done,
    ops: {
      "current-revision": [AFTER_MERGE, AFTER_MERGE],
      "prepare-review": [PREPARED_MERGED],
      "finish-wiki": [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
      "wiki-check": [{ pass: true, checks: [] }],
    },
    sessions: [NO_FINDING],
  });
  stateOf(await mergeRole(unreviewed.ctx), "next");
  assert.deepEqual(opNames(unreviewed.calls), [
    "current-revision",
    "verify",
    "wiki-check",
    "prepare-review",
    "current-revision",
    "finish-wiki",
  ]);
  const cleared = fakeContext({
    stage: "merge",
    state: {
      ...done,
      security: { ...REJECTION, finding: null },
    },
    ops: {
      "current-revision": [AFTER_MERGE],
      "finish-wiki": [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
      "wiki-check": [{ pass: true, checks: [] }],
    },
  });
  stateOf(await mergeRole(cleared.ctx), "next");
  assert.deepEqual(opNames(cleared.calls), [
    "current-revision",
    "verify",
    "wiki-check",
    "finish-wiki",
  ]);
  assert.equal(sessionsOf(cleared.calls).length, 0);
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

test("a change that lives only in the wiki with a security finding stops and never publishes", async () => {
  const wikiOnly = current({}, null);
  const { ctx, calls } = merging({
    state: { pr: null, flows: { code: false, wiki: true } },
    ops: {
      "current-revision": [wikiOnly, wikiOnly, wikiOnly],
      "wiki-sync": [WIKI_UNCHANGED],
      verify: [{ pass: true, headSha: REVISION.code, checks: [] }],
      "prepare-review": [{ ...PREPARED_MERGED, headSha: REVISION.code }],
    },
    sessions: [finding("abuse-risk")],
  });
  assert.equal(endCode(await mergeRole(ctx)), "abuse-risk");
  assert.ok(!opNames(calls).includes("publish"));
  assert.ok(!opNames(calls).includes("finish-wiki"));
});

test("a publish the guard refuses for security stops with error instead of waiting to retry it", async () => {
  const { ctx, calls } = merging({
    ops: {
      publish: [{ published: false, reason: "security", detail: "no review" }],
    },
  });
  const end = await mergeRole(ctx);
  assert.equal(endCode(end), "error");
  assert.ok(end.kind === "stop");
  assert.match(end.reason, SECURITY_REFUSED);
  assert.ok(!opNames(calls).includes("finish-wiki"));
});
