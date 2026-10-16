// @ts-check
// The merge op through the ops CLI: each way it refuses, waits or merges, with
// the exact reply and the gh calls it makes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import {
  advanceBase,
  ask,
  calls,
  commentPost,
  fakeGh,
  finishCalls,
  finishReplies,
  hoursFromNow,
  LANE,
  listCall,
  replyLine,
  SWEEP,
  signedBy,
  stateListing,
  world,
} from "./ops-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { World } from "./ops-test-kit.mjs" */

const VIEW_FIELDS = "headRefOid,state,mergeable,mergeStateStatus,isDraft";
const VIEW_ARGS = ["pr", "view", "50", "-R", "o/r", "--json", VIEW_FIELDS];
const WORKING_ARGS =
  "issue list -R o/r --state open --label agent:working --limit 100 --json number,labels".split(
    " ",
  );
const APPROVAL_HINT =
  " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config.";
// #7 and its PR, the issues on the merge line, and the merger's short sha.
const ISSUE = 7;
const PR = 50;
const AHEAD = 9;
const STOPPED = 10;
const NEWER = 11;
const UNREVIEWED = 12;
const EXPIRED = 13;
const EXPIRED_HOURS = 5;
const ORDER_CALLS = 6;
const READY_CALLS_END = 3;
const SHORT_SHA = 12;
const REASON = z.looseObject({ reason: z.string() });
const STATE = {
  pr: PR,
  stage: "merge",
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};

/** @param {string} sha @param {object} [fields] @returns {GhReply} */
function viewReply(sha, fields = {}) {
  const view = {
    headRefOid: sha,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    ...fields,
  };
  return { when: "pr view", stdout: JSON.stringify(view) };
}

/** @param {string} sha @returns {string[]} */
function mergeArgs(sha) {
  return [..."pr merge 50 -R o/r --squash --match-head-commit".split(" "), sha];
}

// Runs merge for #7's PR #50 at the worktree's head, after queuing `replies`.
/** @param {World} w @param {GhReply[]} replies @param {object} [extra] @returns {string} */
function runMerge(w, replies, extra = {}) {
  fakeGh.reply(replies);
  return ask(w, {
    op: "merge",
    number: ISSUE,
    state: STATE,
    expectedSha: w.sha,
    summary: "All good.",
    ...extra,
  });
}

// The line merge prints for a reply with `fields` after its envelope.
/** @param {object} fields @returns {string} */
function mergeLine(fields) {
  return replyLine({ ok: true, op: "merge", posted: 0, ...fields });
}

// Merge's reply when the PR view shows `fields`.
/** @param {World} w @param {object} fields @returns {string} */
function viewedMerge(w, fields) {
  return runMerge(w, [viewReply(w.sha, fields)]);
}

// The reply of a merge refused for `reason`.
/** @param {string} reason @returns {string} */
function refusal(reason) {
  return mergeLine({ merged: false, reason });
}

test("a PR merged by hand gets the merge bookkeeping and no merge", () => {
  const w = world();
  const out = runMerge(w, [
    viewReply(w.sha, { state: "MERGED" }),
    ...finishReplies(),
  ]);
  assert.equal(out, mergeLine({ merged: true, byHand: true }));
  assert.deepEqual(calls(), [VIEW_ARGS, ...finishCalls(STATE)]);
  assert.equal(fs.existsSync(w.worktree), false);
});

test("a closed PR is refused with its state, after only the view", () => {
  const w = world();
  assert.equal(viewedMerge(w, { state: "CLOSED" }), refusal("PR is CLOSED"));
  assert.deepEqual(calls(), [VIEW_ARGS]);
});

test("a PR whose head moved is refused with the new head", () => {
  const w = world();
  assert.equal(
    runMerge(w, [viewReply("f00d")]),
    mergeLine({ merged: false, reason: "head-changed", headSha: "f00d" }),
  );
});

test("a conflicting PR is refused as a conflict", () => {
  const w = world();
  assert.equal(
    viewedMerge(w, { mergeable: "CONFLICTING" }),
    refusal("conflict"),
  );
});

test("a PR GitHub calls BEHIND is refused as behind", () => {
  const w = world();
  assert.equal(
    viewedMerge(w, { mergeStateStatus: "BEHIND" }),
    refusal("behind"),
  );
});

test("a head that lacks the base's latest commit is behind, with no merge", () => {
  const w = world();
  advanceBase(w);
  assert.equal(viewedMerge(w, {}), refusal("behind"));
  assert.deepEqual(calls(), [VIEW_ARGS]);
});

test("with merge order, an older ready PR holding the line queues the merge", () => {
  const w = world();
  const ahead = { pr: 40, stage: "accept", lease: { at: hoursFromNow(0) } };
  const out = runMerge(
    w,
    [
      viewReply(w.sha),
      { when: "issue list", stdout: '[{"number":9,"labels":[]}]' },
      stateListing(AHEAD, ahead),
    ],
    { mergeOrder: true },
  );
  assert.equal(
    out,
    mergeLine({
      merged: false,
      reason: "queued",
      waitingFor: 9,
      waitingForPr: 40,
    }),
  );
  assert.deepEqual(calls().slice(0, 2), [VIEW_ARGS, WORKING_ARGS]);
});

test("stopped, newer, unreviewed and expired issues don't hold the line", () => {
  const w = world();
  const working = [
    { number: ISSUE, labels: [] },
    { number: STOPPED, labels: [{ name: "agent:stopped-budget" }] },
    { number: NEWER, labels: [] },
    { number: UNREVIEWED, labels: [] },
    { number: EXPIRED, labels: [] },
  ];
  const out = runMerge(
    w,
    [
      viewReply(w.sha),
      { when: "issue list", stdout: JSON.stringify(working) },
      // Ready and older, so only the stop label keeps it out of line.
      stateListing(STOPPED, {
        pr: 20,
        stage: "merge",
        lease: { at: hoursFromNow(0) },
      }),
      stateListing(NEWER, { pr: 60, stage: "accept" }),
      stateListing(UNREVIEWED, { pr: 30, stage: "review" }),
      stateListing(EXPIRED, {
        pr: 20,
        stage: "merge",
        lease: { at: hoursFromNow(-EXPIRED_HOURS) },
      }),
      ...finishReplies(),
    ],
    { mergeOrder: true },
  );
  assert.equal(out, mergeLine({ merged: true }));
  // Neither #7 itself nor the stopped #10 has its state read.
  assert.deepEqual(calls().slice(0, ORDER_CALLS), [
    VIEW_ARGS,
    WORKING_ARGS,
    listCall(NEWER),
    listCall(UNREVIEWED),
    listCall(EXPIRED),
    mergeArgs(w.sha),
  ]);
});

test("a draft PR is marked ready before the merge", () => {
  const w = world();
  runMerge(w, [viewReply(w.sha, { isDraft: true }), ...finishReplies()]);
  assert.deepEqual(calls().slice(1, READY_CALLS_END), [
    ["pr", "ready", "50", "-R", "o/r"],
    mergeArgs(w.sha),
  ]);
});

test("mergeAdmin merges with --admin", () => {
  const w = world();
  const cfg = z
    .looseObject({})
    .parse(JSON.parse(fs.readFileSync(w.config, "utf8")));
  fs.writeFileSync(w.config, JSON.stringify({ ...cfg, mergeAdmin: true }));
  runMerge(w, [viewReply(w.sha), ...finishReplies()]);
  assert.deepEqual(calls()[1], [...mergeArgs(w.sha), "--admin"]);
});

test("a merge refused for want of approval says so and how to fix it", () => {
  const w = world();
  const why = "GraphQL: At least 1 approving review is required.";
  const out = runMerge(w, [
    viewReply(w.sha),
    { when: "pr merge", stderr: `${why}\n`, code: 1 },
  ]);
  assert.equal(
    out,
    mergeLine({
      merged: false,
      reason: `merge refused: ${why}${APPROVAL_HINT}`,
    }),
  );
  assert.deepEqual(calls(), [VIEW_ARGS, mergeArgs(w.sha)]);
});

test("a merge refused for another reason gets no hint", () => {
  const w = world();
  const out = runMerge(w, [
    viewReply(w.sha),
    { when: "pr merge", stdout: "Pull request is locked\n", code: 1 },
  ]);
  const { reason } = REASON.parse(JSON.parse(out));
  assert.equal(reason, "merge refused: Pull request is locked");
});

test("a merge refused because the base branch was modified is behind", () => {
  const w = world();
  const out = runMerge(w, [
    viewReply(w.sha),
    { when: "pr merge", stderr: "Base branch was modified.\n", code: 1 },
  ]);
  assert.equal(out, refusal("behind"));
});

test("a merge squashes, records the verdict and finishes the issue", () => {
  const w = world();
  const out = runMerge(w, [viewReply(w.sha), ...finishReplies()]);
  assert.equal(out, mergeLine({ merged: true }));
  const verdict = `Merged ${w.sha.slice(0, SHORT_SHA)}: every blocking review finding is resolved and every check passed on this commit.\n\nAll good.`;
  assert.deepEqual(calls(), [
    VIEW_ARGS,
    mergeArgs(w.sha),
    commentPost(PR, signedBy("merger", verdict)),
    ...finishCalls(STATE),
  ]);
  assert.equal(fs.existsSync(w.worktree), false);
});
