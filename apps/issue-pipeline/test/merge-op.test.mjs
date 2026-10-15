// The merge op through the ops CLI: each way it refuses, waits or merges, with
// the exact reply and the gh calls it makes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  advanceBase,
  ask,
  assertReply,
  calls,
  commentPost,
  fakeGh,
  finishCalls,
  finishReplies,
  hoursFromNow,
  LANE,
  listCall,
  SWEEP,
  signedBy,
  stateListing,
  world,
} from "./ops-test-kit.mjs";

const VIEW_ARGS = [
  "pr",
  "view",
  "50",
  "-R",
  "o/r",
  "--json",
  "headRefOid,state,mergeable,mergeStateStatus,isDraft",
];
const WORKING_ARGS = [
  "issue",
  "list",
  "-R",
  "o/r",
  "--state",
  "open",
  "--label",
  "agent:working",
  "--limit",
  "100",
  "--json",
  "number,labels",
];
const APPROVAL_HINT =
  " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config.";
const STATE = {
  pr: 50,
  stage: "merge",
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};

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

function mergeArgs(sha) {
  return [
    "pr",
    "merge",
    "50",
    "-R",
    "o/r",
    "--squash",
    "--match-head-commit",
    sha,
  ];
}

// Runs merge for #7's PR #50 at the worktree's head, after queuing `replies`.
function runMerge(w, replies, extra = {}) {
  fakeGh.reply(replies);
  return ask(w, {
    op: "merge",
    number: 7,
    state: STATE,
    expectedSha: w.sha,
    summary: "All good.",
    ...extra,
  });
}

const refused = (w, reason, fields) => {
  assertReply(runMerge(w, [viewReply(w.sha, fields)]), {
    ok: true,
    op: "merge",
    posted: 0,
    merged: false,
    reason,
  });
};

test("a PR merged by hand gets the merge bookkeeping and no merge", () => {
  const w = world();
  const out = runMerge(w, [
    viewReply(w.sha, { state: "MERGED" }),
    ...finishReplies(),
  ]);
  assertReply(out, {
    ok: true,
    op: "merge",
    posted: 0,
    merged: true,
    byHand: true,
  });
  assert.deepEqual(calls(), [VIEW_ARGS, ...finishCalls(STATE)]);
  assert.equal(fs.existsSync(w.worktree), false);
});

test("a closed PR is refused with its state, after only the view", () => {
  const w = world();
  refused(w, "PR is CLOSED", { state: "CLOSED" });
  assert.deepEqual(calls(), [VIEW_ARGS]);
});

test("a PR whose head moved is refused with the new head", () => {
  const w = world();
  assertReply(runMerge(w, [viewReply("f00d")]), {
    ok: true,
    op: "merge",
    posted: 0,
    merged: false,
    reason: "head-changed",
    headSha: "f00d",
  });
});

test("a conflicting PR is refused as a conflict", () => {
  const w = world();
  refused(w, "conflict", { mergeable: "CONFLICTING" });
});

test("a PR GitHub calls BEHIND is refused as behind", () => {
  const w = world();
  refused(w, "behind", { mergeStateStatus: "BEHIND" });
});

test("a head that lacks the base's latest commit is behind, with no merge", () => {
  const w = world();
  advanceBase(w);
  refused(w, "behind", {});
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
      stateListing(9, ahead),
    ],
    { mergeOrder: true },
  );
  assertReply(out, {
    ok: true,
    op: "merge",
    posted: 0,
    merged: false,
    reason: "queued",
    waitingFor: 9,
    waitingForPr: 40,
  });
  assert.deepEqual(calls().slice(0, 2), [VIEW_ARGS, WORKING_ARGS]);
});

test("stopped, newer, unreviewed and expired issues don't hold the line", () => {
  const w = world();
  const working = [
    { number: 7, labels: [] },
    { number: 10, labels: [{ name: "agent:stopped-budget" }] },
    { number: 11, labels: [] },
    { number: 12, labels: [] },
    { number: 13, labels: [] },
  ];
  const out = runMerge(
    w,
    [
      viewReply(w.sha),
      { when: "issue list", stdout: JSON.stringify(working) },
      // Ready and older, so only the stop label keeps it out of line.
      stateListing(10, {
        pr: 20,
        stage: "merge",
        lease: { at: hoursFromNow(0) },
      }),
      stateListing(11, { pr: 60, stage: "accept" }),
      stateListing(12, { pr: 30, stage: "review" }),
      stateListing(13, {
        pr: 20,
        stage: "merge",
        lease: { at: hoursFromNow(-5) },
      }),
      ...finishReplies(),
    ],
    { mergeOrder: true },
  );
  assertReply(out, { ok: true, op: "merge", posted: 0, merged: true });
  // Neither #7 itself nor the stopped #10 has its state read.
  assert.deepEqual(calls().slice(0, 6), [
    VIEW_ARGS,
    WORKING_ARGS,
    listCall(11),
    listCall(12),
    listCall(13),
    mergeArgs(w.sha),
  ]);
});

test("a draft PR is marked ready before the merge", () => {
  const w = world();
  runMerge(w, [viewReply(w.sha, { isDraft: true }), ...finishReplies()]);
  assert.deepEqual(calls().slice(1, 3), [
    ["pr", "ready", "50", "-R", "o/r"],
    mergeArgs(w.sha),
  ]);
});

test("mergeAdmin merges with --admin", () => {
  const w = world();
  const cfg = JSON.parse(fs.readFileSync(w.config, "utf8"));
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
  assertReply(out, {
    ok: true,
    op: "merge",
    posted: 0,
    merged: false,
    reason: `merge refused: ${why}${APPROVAL_HINT}`,
  });
  assert.deepEqual(calls(), [VIEW_ARGS, mergeArgs(w.sha)]);
});

test("a merge refused for another reason gets no hint", () => {
  const w = world();
  const out = runMerge(w, [
    viewReply(w.sha),
    { when: "pr merge", stdout: "Pull request is locked\n", code: 1 },
  ]);
  assert.equal(JSON.parse(out).reason, "merge refused: Pull request is locked");
});

test("a merge refused because the base branch was modified is behind", () => {
  const w = world();
  const out = runMerge(w, [
    viewReply(w.sha),
    { when: "pr merge", stderr: "Base branch was modified.\n", code: 1 },
  ]);
  assertReply(out, {
    ok: true,
    op: "merge",
    posted: 0,
    merged: false,
    reason: "behind",
  });
});

test("a merge squashes, records the verdict and finishes the issue", () => {
  const w = world();
  const out = runMerge(w, [viewReply(w.sha), ...finishReplies()]);
  assertReply(out, { ok: true, op: "merge", posted: 0, merged: true });
  const verdict = `Merged ${w.sha.slice(0, 12)}: every blocking review finding is resolved and every check passed on this commit.\n\nAll good.`;
  assert.deepEqual(calls(), [
    VIEW_ARGS,
    mergeArgs(w.sha),
    commentPost(50, signedBy("merger", verdict)),
    ...finishCalls(STATE),
  ]);
  assert.equal(fs.existsSync(w.worktree), false);
});
