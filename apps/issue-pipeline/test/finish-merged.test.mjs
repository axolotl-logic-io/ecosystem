// The bookkeeping after a PR merges, run here through merge on a PR merged by
// hand: pushing the issue's wiki commits, saying so or why not on the issue,
// keeping the worktree when the push fails, and leaving a closed issue alone.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ask,
  assertReply,
  calls,
  claimListing,
  commentPost,
  fakeGh,
  finishCalls,
  finishReplies,
  GIT_USER,
  hoursFromNow,
  LANE,
  SWEEP,
  sh,
  signedBy,
  world,
} from "./ops-test-kit.mjs";

const ISSUE = 7;
const SHORT_SHA_LENGTH = 12;
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
};
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

// Turns the wiki on and sets it up as ensureWiki does: a bare wiki origin, the
// shared wiki clone, and #7's wiki checkout one commit ahead. A rejecting
// origin refuses every push. Returns the wiki origin and the issue's commit.
function withWiki(w, { rejectPushes = false } = {}) {
  const origin = path.join(w.root, "wiki.git");
  const clone = path.join(w.root, "clones/o__r.wiki");
  const dir = path.join(w.worktree, "wiki");
  const config = JSON.parse(fs.readFileSync(w.config, "utf8"));
  fs.writeFileSync(w.config, JSON.stringify({ ...config, wiki: true }));
  sh(
    `cd ${w.root} && git init -q --bare -b master wiki.git && git clone -q wiki.git ${clone} 2>/dev/null && git -C ${clone} ${GIT_USER} commit -q --allow-empty -m home && git -C ${clone} push -q origin HEAD:master`,
  );
  sh(
    `git -C ${clone} worktree add -q -b agent/issue-7 ${dir} origin/master && git -C ${dir} ${GIT_USER} commit -q --allow-empty -m page`,
  );
  if (rejectPushes) {
    fs.writeFileSync(
      path.join(origin, "hooks/pre-receive"),
      "#!/bin/sh\nexit 1\n",
      {
        mode: 0o755,
      },
    );
  }
  return { origin, sha: sh(`git -C ${dir} rev-parse HEAD`) };
}

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

// calls() after merge's PR view, which merge-op.test.mjs pins.
function finishingCalls() {
  return calls().slice(1);
}

test("a pushed wiki commit is named on the issue and the worktree goes", () => {
  const w = world();
  const wiki = withWiki(w);
  assertReply(mergedByHand(w, finishReplies()), BY_HAND);
  const pushed = `Pushed this issue's wiki changes as wiki commit ${wiki.sha.slice(0, SHORT_SHA_LENGTH)} (history: https://github.com/o/r/wiki/_history).`;
  assert.deepEqual(finishingCalls(), [
    ...finishCalls(STATE),
    commentPost(ISSUE, signedBy("merger", pushed)),
  ]);
  assert.equal(sh(`git -C ${wiki.origin} rev-parse master`), wiki.sha);
  assert.equal(fs.existsSync(w.worktree), false);
});

test("a wiki push that fails is reported and the worktree stays", () => {
  const w = world();
  const wiki = withWiki(w, { rejectPushes: true });
  assertReply(mergedByHand(w, finishReplies()), BY_HAND);
  const failed =
    "The wiki changes from this issue were not pushed: could not push the wiki changes after 3 attempts";
  assert.deepEqual(finishingCalls(), [
    ...finishCalls(STATE),
    commentPost(ISSUE, signedBy("merger", failed)),
  ]);
  assert.notEqual(sh(`git -C ${wiki.origin} rev-parse master`), wiki.sha);
  assert.equal(fs.existsSync(w.worktree), true);
});

test("an issue already closed is not closed again", () => {
  const w = world();
  const closed = { when: "--jq {state}", stdout: '{"state":"closed"}' };
  const replies = [claimListing(), claimListing(), closed];
  assertReply(mergedByHand(w, replies), BY_HAND);
  const open = finishCalls(STATE);
  assert.equal(open.at(-1)[0], "issue");
  assert.deepEqual(finishingCalls(), open.slice(0, -1));
  assert.equal(fs.existsSync(w.worktree), false);
});
