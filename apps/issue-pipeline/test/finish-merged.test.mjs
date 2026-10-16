// @ts-check
// The bookkeeping after a PR merges, run here through merge on a PR merged by
// hand: publishing the issue's wiki commits on the wiki's master, finishing
// the issue once they are there, keeping it open at the publish stage when
// they conflict or can't be pushed, and leaving a closed issue alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ask,
  claimListing,
  commentPost,
  fakeGh,
  finishReplies,
  finishWrites,
  hoursFromNow,
  LANE,
  replyLine,
  SWEEP,
  sh,
  signedBy,
  stateBody,
  world,
  writes,
} from "./ops-test-kit.mjs";
import { hasBranch, withWiki } from "./wiki-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { World } from "./ops-test-kit.mjs" */

const ISSUE = 7;
const SHORT_SHA_LENGTH = 12;
// finishMerged's first writes: the branch delete and the PR's two label writes.
const PR_WRITES = 3;
const STATE = {
  pr: 50,
  stage: "merge",
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};
const BY_HAND = {
  ok: true,
  op: "merge",
  posted: 0,
  merged: true,
  byHand: true,
  published: true,
};
const UNPUBLISHED = { ...BY_HAND, published: false };
const MERGED_VIEW = {
  when: "pr view",
  stdout: JSON.stringify({
    headRefOid: "f00d",
    state: "MERGED",
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    isDraft: false,
  }),
};

/** @param {World} w @returns {boolean} */
function patchSaved(w) {
  const runDir = path.join(w.root, "runs/o__r/issue-7");
  return fs.existsSync(path.join(runDir, "wiki-unpushed.patch"));
}

// The writes a merge that didn't publish makes: the branch delete and the PR's
// labels, then `between`, then the issue's state at the publish stage.
/** @param {string[][]} between @returns {string[][]} */
function unpublishedWrites(between) {
  const atPublish = { ...STATE, stage: "publish" };
  const done = finishWrites(STATE);
  return [
    ...done.slice(0, PR_WRITES),
    ...between,
    commentPost(ISSUE, stateBody(ISSUE, atPublish)),
  ];
}

/** @param {World} w @param {GhReply[]} replies @returns {string} */
function mergedByHand(w, replies) {
  fakeGh.reply([MERGED_VIEW, ...replies]);
  return ask(w, {
    op: "merge",
    number: ISSUE,
    state: STATE,
    expectedSha: w.sha,
    summary: "All good.",
  });
}

test("a clean publish puts the wiki commit on master and finishes the issue", () => {
  const w = world();
  const wiki = withWiki(w);
  assert.equal(mergedByHand(w, finishReplies()), replyLine(BY_HAND));
  const pushed = `Pushed this issue's wiki changes as wiki commit ${wiki.sha.slice(0, SHORT_SHA_LENGTH)} (history: https://github.com/o/r/wiki/_history).`;
  assert.deepEqual(
    writes(),
    finishWrites(STATE, [commentPost(ISSUE, signedBy("merger", pushed))]),
  );
  assert.equal(sh(`git -C ${wiki.origin} log -1 --format=%s master`), "page");
  assert.equal(hasBranch(wiki.origin, "agent/issue-7"), false);
  assert.equal(patchSaved(w), false);
  assert.equal(fs.existsSync(w.worktree), false);
});

test("a wiki conflict keeps the issue open at the publish stage with no patch", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  assert.equal(mergedByHand(w, finishReplies()), replyLine(UNPUBLISHED));
  assert.deepEqual(writes(), unpublishedWrites([]));
  assert.equal(sh(`git -C ${wiki.origin} log -1 --format=%s master`), "other");
  assert.equal(hasBranch(wiki.origin, "agent/issue-7"), true);
  assert.equal(patchSaved(w), false);
  assert.equal(fs.existsSync(w.worktree), true);
});

test("a wiki push that keeps failing is reported and retried at the publish stage", () => {
  const w = world();
  const wiki = withWiki(w, { rejectPushes: true });
  assert.equal(mergedByHand(w, finishReplies()), replyLine(UNPUBLISHED));
  const failed =
    "The wiki changes from this issue were not published: could not push the wiki changes after 3 attempts. The pipeline will retry the publish.";
  assert.deepEqual(
    writes(),
    unpublishedWrites([commentPost(ISSUE, signedBy("merger", failed))]),
  );
  assert.notEqual(sh(`git -C ${wiki.origin} rev-parse master`), wiki.sha);
  assert.equal(patchSaved(w), false);
  assert.equal(fs.existsSync(w.worktree), true);
});

test("an issue already closed is not closed again", () => {
  const w = world();
  const closed = { when: "--jq {state}", stdout: '{"state":"closed"}' };
  const replies = [claimListing(), claimListing(), closed];
  assert.equal(mergedByHand(w, replies), replyLine(BY_HAND));
  const open = finishWrites(STATE);
  assert.equal(open.at(-1)?.[1], "close");
  assert.deepEqual(writes(), open.slice(0, -1));
  assert.equal(fs.existsSync(w.worktree), false);
});
