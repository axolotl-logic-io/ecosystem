// @ts-check
// The merge op with the orchestrator's ranked merge queue (#234): only a
// ready issue ahead of this one in the queue holds its merge, in place of
// the lowest-PR order.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ask,
  calls,
  fakeGh,
  finishReplies,
  hoursFromNow,
  LANE,
  listCall,
  replyLine,
  SWEEP,
  stateListing,
  world,
} from "./ops-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { World } from "./ops-test-kit.mjs" */

const ISSUE = 7;
const PR = 50;
const CLOSED = 12;
const STOPPED = 9;
const UNREADY = 11;
const BEHIND = 13;
const ORDER_CALLS = 5;
const VIEW_ARGS = [
  ..."pr view 50 -R o/r --json".split(" "),
  "headRefOid,state,mergeable,mergeStateStatus,isDraft",
];
const STATE = {
  pr: PR,
  stage: "merge",
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};

/** @param {string} sha @returns {GhReply} */
function viewReply(sha) {
  const view = {
    headRefOid: sha,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
  };
  return { when: "pr view", stdout: JSON.stringify(view) };
}

// gh's view of issue #n, whatever the number of open issues.
/** @param {number} n @param {string} state @param {string[]} labels @returns {GhReply} */
function issueView(n, state, labels) {
  const issue = { state, labels: labels.map((name) => ({ name })) };
  return { when: `issue view ${n} `, stdout: JSON.stringify(issue) };
}

/** @param {number} n @returns {string[]} */
function viewIssueArgs(n) {
  return `issue view ${n} -R o/r --json state,labels`.split(" ");
}

// Merges #7 with merge order and `queue`, after queuing `replies`.
/** @param {World} w @param {number[]} queue @param {GhReply[]} replies @returns {string} */
function queuedMerge(w, queue, replies) {
  fakeGh.reply([viewReply(w.sha), ...replies]);
  return ask(w, {
    op: "merge",
    number: ISSUE,
    state: STATE,
    expectedSha: w.sha,
    summary: "All good.",
    mergeOrder: true,
    mergeQueue: queue,
  });
}

test("a ready issue ahead in the merge queue holds the merge, whatever its PR", () => {
  const w = world();
  const out = queuedMerge(
    w,
    [UNREADY, ISSUE],
    [
      issueView(UNREADY, "OPEN", []),
      stateListing(UNREADY, { pr: 60, stage: "accept" }),
    ],
  );
  assert.equal(
    out,
    replyLine({
      ok: true,
      op: "merge",
      posted: 0,
      merged: false,
      reason: "queued",
      waitingFor: UNREADY,
      waitingForPr: 60,
    }),
  );
  // The issue ahead is read on its own, so no list limit leaves it out.
  assert.deepEqual(calls().slice(0, 2), [VIEW_ARGS, viewIssueArgs(UNREADY)]);
});

test("closed, stopped and unready issues ahead, and older PRs behind, don't hold it", () => {
  const w = world();
  const out = queuedMerge(
    w,
    [CLOSED, STOPPED, UNREADY, ISSUE, BEHIND],
    [
      issueView(CLOSED, "CLOSED", []),
      issueView(STOPPED, "OPEN", ["agent:stopped-budget"]),
      issueView(UNREADY, "OPEN", []),
      stateListing(UNREADY, { pr: 20, stage: "review" }),
      // Ready with an older PR, but behind #7 in the queue.
      stateListing(BEHIND, { pr: 10, stage: "merge" }),
      ...finishReplies(),
    ],
  );
  assert.equal(
    out,
    replyLine({
      ok: true,
      op: "merge",
      posted: 0,
      merged: true,
      published: true,
    }),
  );
  // Only the issues ahead are viewed, and only the open, unstopped #11 has
  // its state read.
  assert.deepEqual(calls().slice(0, ORDER_CALLS), [
    VIEW_ARGS,
    viewIssueArgs(CLOSED),
    viewIssueArgs(STOPPED),
    viewIssueArgs(UNREADY),
    listCall(UNREADY),
  ]);
  assert.equal(calls()[ORDER_CALLS]?.[1], "merge");
});
