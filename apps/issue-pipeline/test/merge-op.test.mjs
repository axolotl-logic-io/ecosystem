// @ts-check
// The merge op (src/ops/merge.ts) only merges code: it checks the approved
// head, the queue and the fresh revision, names the target and exact source
// and durably checkpoints attempted/confirmed evidence, without labels or
// issue close (`merge-publish-finish-split`).
// Branches are no longer stacked on a prerequisite's branch (#268): an issue
// whose after mark names an open prerequisite doesn't start at all
// (orchestrator.test "an open prerequisite in the after mark holds…"), so
// merge-stacked-op.test.mjs is retired; a branch behind its base is refused
// here ("merge refuses a head behind its base without merging") and the
// queue's hold is "an issue ahead in the merge queue at review holds the
// merge, whatever its verdict".
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalReply, mergeCommentReplies } from "./merge-op-fixtures.mjs";
import { approvedOf, current, request } from "./merge-op-test-kit.mjs";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  boundState,
  fakeGh,
  ISSUE,
  mergeAuthority,
  PR,
  prView,
  REPO,
  savedListing,
  sh,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");

const COMMENTS_ON_PR = /issues\/50\/comments/u;
const NO_MERGE_COMMIT = /no merge commit/u;
const NOT_APPROVED_CODE = /not the approved code/u;
const NOT_ISSUE_BRANCH = /not agent\/issue-7/u;
const FULL_SHA_LENGTH = 40;
const EARLIER = 3;
const QUEUE = [EARLIER, ISSUE];
const SUCCESS_WRITES = 2;

test("merge records exact-head approval then returns the configured target's merge receipt", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha }),
    approvalReply(w),
    ...mergeAuthority(boundState(w, approvedOf(w))),
    ...mergeCommentReplies(),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: w.sha },
    }),
  ]);
  const reply = merge(w.cfg, request(w));
  assert.deepEqual(reply, {
    merged: true,
    mergeCommit: w.sha,
    headSha: w.sha,
  });
  const done = writes().filter((args) => !args.includes("PATCH"));
  assert.equal(done[0]?.[1], `repos/${REPO}/pulls/${PR}/reviews`);
  assert.equal(
    sh(`git --git-dir=${w.root}/origin.git rev-parse integration`),
    w.sha,
  );
  assert.equal(
    done.some((args) => args[1] === `repos/${REPO}/merges`),
    false,
  );
  assert.equal(done.length, SUCCESS_WRITES);
  assert.match(done[1]?.join(" ") ?? "", COMMENTS_ON_PR);
});

test("merge of a PR merged by hand returns the authoritative receipt and merges nothing", () => {
  const w = world();
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({
      headRefOid: "f00d",
      state: "MERGED",
      mergeCommit: { oid: w.mergeSha },
    }),
  ]);
  const reply = merge(w.cfg, request(w));
  assert.deepEqual(reply, {
    merged: true,
    byHand: true,
    mergeCommit: w.mergeSha,
    headSha: "f00d",
  });
  assert.deepEqual(writes(), []);
});

test("merge of a merged PR with no merge commit fails instead of an empty receipt", () => {
  const w = world();
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({ headRefOid: w.sha, state: "MERGED" }),
  ]);
  assert.throws(() => merge(w.cfg, request(w)), NO_MERGE_COMMIT);
  assert.deepEqual(writes(), []);
});

test("merge refuses a moved head, and an expectedSha other than the approved code fails", () => {
  const w = world();
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({ headRefOid: "0ther" }),
  ]);
  assert.deepEqual(merge(w.cfg, request(w)), {
    merged: false,
    reason: "head-changed",
    headSha: "0ther",
  });
  assert.throws(
    () =>
      merge(w.cfg, request(w, { expectedSha: "a".repeat(FULL_SHA_LENGTH) })),
    NOT_APPROVED_CODE,
  );
  assert.deepEqual(writes(), []);
});

test("merge refuses a PR from another branch", () => {
  const w = world();
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({ headRefOid: w.sha, headRefName: "evil" }),
  ]);
  assert.throws(() => merge(w.cfg, request(w)), NOT_ISSUE_BRANCH);
});

test("merge refuses a stale revision with the current one, before merging", () => {
  const w = world();
  const moved = { ...approvedOf(w), inputs: "inputs-2" };
  setCurrentRevision({ revision: moved, baseSha: "base", pr: null });
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({ headRefOid: w.sha }),
  ]);
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
  const ahead = { ...boundState(w, approvedOf(w)), number: 3, pr: 30 };
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
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
    prView({ headRefOid: w.sha }),
    approvalReply(w),
    ...mergeAuthority(boundState(w, approvedOf(w))),
    ...mergeCommentReplies(),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: w.sha },
    }),
  ]);
  const reply = merge(w.cfg, request(w, { mergeQueue: QUEUE }));
  assert.equal(reply.merged, true);
});

test("merge refuses a head behind its base without merging", () => {
  const w = world();
  current(w);
  fakeGh.reply([
    savedListing(boundState(w, approvedOf(w))),
    prView({ headRefOid: w.sha, mergeStateStatus: "BEHIND" }),
  ]);
  assert.deepEqual(merge(w.cfg, request(w)), {
    merged: false,
    reason: "behind",
  });
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
          ...boundState(w, approvedOf(w)),
          number: 3,
          pr: 30,
          stage,
          lease,
        }),
        when: "issues/3/comments?per_page",
      },
    ];
  }
  fakeGh.reply([savedListing(boundState(w, approvedOf(w))), ...older("merge")]);
  assert.deepEqual(merge(w.cfg, request(w, { mergeOrder: true })), {
    merged: false,
    reason: "queued",
    waitingFor: 3,
    waitingForPr: 30,
  });
  fakeGh.reply([
    ...older("review"),
    prView({ headRefOid: w.sha }),
    approvalReply(w),
    ...mergeAuthority(boundState(w, approvedOf(w))),
    ...mergeCommentReplies(),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: w.sha },
    }),
  ]);
  assert.equal(merge(w.cfg, request(w, { mergeOrder: true })).merged, true);
});
