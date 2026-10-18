// @ts-check
// The merge op (src/ops/merge.ts) only merges code: it checks the approved
// head, the queue and the fresh revision, squash-merges at the approved head
// and returns GitHub's merge receipt, writing no state, labels, wiki or
// issue close (`merge-publish-finish-split`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  ISSUE,
  MERGE_COMMIT,
  PR,
  prView,
  REPO,
  savedListing,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
// What the merge op's writes and refusals say.
const COMMENTS_ON_PR = /issues\/50\/comments/u;
const NO_MERGE_COMMIT = /no merge commit/u;
const NOT_APPROVED_CODE = /not the approved code/u;
const NOT_ISSUE_BRANCH = /not agent\/issue-7/u;
// An older issue's merge queued ahead of #7.
const EARLIER = 3;
const QUEUE = [EARLIER, ISSUE];

/** @param {World} w @returns {{ code: string, wiki: null, inputs: string }} */
function approvedOf(w) {
  return { code: w.sha, wiki: null, inputs: "inputs-1" };
}

/** @param {World} w @param {object} [extra] @returns {object} */
function request(w, extra = {}) {
  const approved = approvedOf(w);
  return {
    number: ISSUE,
    state: approvedState(approved),
    expectedSha: w.sha,
    revision: approved,
    mergeQueue: null,
    summary: "All good.",
    ...extra,
  };
}

/** @param {World} w @returns {void} */
function current(w) {
  setCurrentRevision({
    revision: approvedOf(w),
    baseSha: "base",
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

test("merge squash-merges at the approved head and returns GitHub's merge receipt, writing nothing else", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    { when: "pr merge 50" },
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  const reply = merge(w.cfg, request(w));
  assert.deepEqual(reply, {
    merged: true,
    mergeCommit: MERGE_COMMIT,
    headSha: w.sha,
  });
  const done = writes();
  assert.deepEqual(done[0], [
    "pr",
    "merge",
    "50",
    "-R",
    REPO,
    "--squash",
    "--match-head-commit",
    w.sha,
  ]);
  assert.equal(done.length, 2);
  assert.match(done[1]?.join(" ") ?? "", COMMENTS_ON_PR);
});

test("merge of a PR merged by hand returns the authoritative receipt and merges nothing", () => {
  const w = world();
  fakeGh.reply([
    prView({
      headRefOid: "f00d",
      state: "MERGED",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  const reply = merge(w.cfg, request(w));
  assert.deepEqual(reply, {
    merged: true,
    byHand: true,
    mergeCommit: MERGE_COMMIT,
    headSha: "f00d",
  });
  assert.deepEqual(writes(), []);
});

test("merge of a merged PR with no merge commit fails instead of an empty receipt", () => {
  const w = world();
  fakeGh.reply([prView({ headRefOid: w.sha, state: "MERGED" })]);
  assert.throws(() => merge(w.cfg, request(w)), NO_MERGE_COMMIT);
  assert.deepEqual(writes(), []);
});

test("merge refuses a moved head, and an expectedSha other than the approved code fails", () => {
  const w = world();
  fakeGh.reply([prView({ headRefOid: "0ther" })]);
  assert.deepEqual(merge(w.cfg, request(w)), {
    merged: false,
    reason: "head-changed",
    headSha: "0ther",
  });
  assert.throws(
    () => merge(w.cfg, request(w, { expectedSha: "0ther" })),
    NOT_APPROVED_CODE,
  );
  assert.deepEqual(writes(), []);
});

test("merge refuses a PR from another branch", () => {
  const w = world();
  fakeGh.reply([prView({ headRefOid: w.sha, headRefName: "evil" })]);
  assert.throws(() => merge(w.cfg, request(w)), NOT_ISSUE_BRANCH);
});

test("merge refuses a stale revision with the current one, before merging", () => {
  const w = world();
  const moved = { ...approvedOf(w), inputs: "inputs-2" };
  setCurrentRevision({ revision: moved, baseSha: "base", pr: null });
  fakeGh.reply([prView({ headRefOid: w.sha })]);
  assert.deepEqual(merge(w.cfg, request(w)), {
    merged: false,
    reason: "stale",
    current: moved,
  });
  assert.deepEqual(writes(), []);
});

test("an issue ahead in the merge queue at review holds the merge, whatever its verdict", () => {
  const w = world();
  current(w);
  const ahead = { ...approvedState(approvedOf(w)), number: 3, pr: 30 };
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    { when: "issue view 3", stdout: '{"state":"OPEN","labels":[]}' },
    {
      ...savedListing({ ...ahead, stage: "review", review: { verdict: null } }),
      when: "issues/3/comments?per_page",
    },
  ]);
  assert.deepEqual(merge(w.cfg, request(w, { mergeQueue: QUEUE })), {
    merged: false,
    reason: "queued",
    waitingFor: 3,
    waitingForPr: 30,
  });
  assert.deepEqual(writes(), []);
});

test("a stopped issue ahead in the queue doesn't hold the merge", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    {
      when: "issue view 3",
      stdout: '{"state":"OPEN","labels":[{"name":"agent:stopped-error"}]}',
    },
    { when: "pr merge 50" },
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  const reply = merge(w.cfg, request(w, { mergeQueue: QUEUE }));
  assert.equal(reply.merged, true);
});

test("merge refuses a head behind its base without merging", () => {
  const w = world();
  current(w);
  fakeGh.reply([prView({ headRefOid: w.sha, mergeStateStatus: "BEHIND" })]);
  assert.deepEqual(merge(w.cfg, request(w)), {
    merged: false,
    reason: "behind",
  });
  assert.deepEqual(writes(), []);
});

test("merge refuses when the wiki moved past the approved wiki head", async () => {
  const w = world({ wiki: true });
  const { moveWiki } = await import("./ops-publish-test-kit.mjs");
  moveWiki(w);
  const approved = { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" };
  setCurrentRevision({
    revision: approved,
    baseSha: "base",
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
  fakeGh.reply([prView({ headRefOid: w.sha })]);
  const reply = merge(
    w.cfg,
    request(w, { revision: approved, state: approvedState(approved) }),
  );
  assert.equal(reply.merged, false);
  assert.equal("reason" in reply && reply.reason, "wiki-behind");
  assert.deepEqual(writes(), []);
});

test("with mergeOrder and no queue, an older PR at merge holds the merge and one at review doesn't", () => {
  const w = world();
  current(w);
  const lease = { lane: "L", sweepId: "s1", at: new Date().toISOString() };
  /** @param {string} stage @returns {import("./fake-gh.mjs").GhReply[]} */
  function older(stage) {
    return [
      prView({ headRefOid: w.sha }),
      { when: "issue list", stdout: '[{"number":3,"labels":[]}]' },
      {
        ...savedListing({
          ...approvedState(approvedOf(w)),
          number: 3,
          pr: 30,
          stage,
          lease,
        }),
        when: "issues/3/comments?per_page",
      },
    ];
  }
  fakeGh.reply(older("merge"));
  assert.deepEqual(merge(w.cfg, request(w, { mergeOrder: true })), {
    merged: false,
    reason: "queued",
    waitingFor: 3,
    waitingForPr: 30,
  });
  fakeGh.reply([
    ...older("review"),
    { when: "pr merge 50" },
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  assert.equal(merge(w.cfg, request(w, { mergeOrder: true })).merged, true);
});
