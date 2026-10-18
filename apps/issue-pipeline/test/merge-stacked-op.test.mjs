// @ts-check
// The merge op for a stacked issue (#288, #289): while its prerequisite is
// open the merge waits for it, whatever the merge order, and once the
// prerequisite merged it is behind until the sync unstacks it, once no ready
// issue ahead of it in the merge order holds it (#422).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ask,
  fakeGh,
  finishReplies,
  hoursFromNow,
  LANE,
  replyLine,
  SWEEP,
  stateListing,
  world,
  writes,
} from "./ops-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */
/** @import { World } from "./ops-test-kit.mjs" */

// #7 and its PR, and its prerequisite #9 and the prerequisite's PR.
const ISSUE = 7;
const PR = 50;
const PREREQ = 9;
const PREREQ_PR = 41;
// An issue ahead of #7 in the merge queue, and its PR.
const AHEAD = 14;
const AHEAD_PR = 60;
const STATE = {
  pr: PR,
  stage: "merge",
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};
const NOT_MERGED = { when: "agent/issue-9 --state merged", stdout: "[]" };
const MERGED = {
  when: "agent/issue-9 --state merged",
  stdout: '[{"number":41}]',
};
const ISSUE_OPEN = {
  when: "api repos/o/r/issues/9",
  stdout: '{"state":"open","reason":null}',
};
const OPEN_PR = {
  when: "agent/issue-9 --state open",
  stdout: '[{"number":41}]',
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

// Merges #7 stacked on `stackedOn`, after queuing `replies`.
/** @param {World} w @param {object | null} stackedOn @param {GhReply[]} replies @param {object} [extra] @returns {string} */
function runMerge(w, stackedOn, replies, extra = {}) {
  fakeGh.reply([viewReply(w.sha), ...replies]);
  return ask(w, {
    op: "merge",
    number: ISSUE,
    state: { ...STATE, stackedOn },
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

// The reply of a merge waiting for prerequisite #9 and its PR `pr`.
/** @param {number} pr @returns {string} */
function waitsForPrereq(pr) {
  return mergeLine({
    merged: false,
    reason: "queued",
    waitingFor: PREREQ,
    waitingForPr: pr,
    stackedOn: PREREQ,
  });
}

test("a PR stacked on an open prerequisite waits for it, naming it", () => {
  const w = world();
  const stackedOn = { issue: PREREQ, headSha: w.sha };
  const out = runMerge(w, stackedOn, [NOT_MERGED, ISSUE_OPEN, OPEN_PR]);
  assert.equal(out, waitsForPrereq(PREREQ_PR));
  assert.deepEqual(writes(), []);
});

test("with a merge queue, a stacked PR still waits for its open prerequisite", () => {
  const w = world();
  const stackedOn = { issue: PREREQ, headSha: w.sha };
  const out = runMerge(w, stackedOn, [NOT_MERGED, ISSUE_OPEN, OPEN_PR], {
    mergeOrder: true,
    mergeQueue: [ISSUE, PREREQ],
  });
  assert.equal(out, waitsForPrereq(PREREQ_PR));
  assert.deepEqual(writes(), []);
});

test("a stacked PR whose prerequisite has no PR waits with PR 0", () => {
  const w = world();
  const stackedOn = { issue: PREREQ, headSha: w.sha };
  const out = runMerge(w, stackedOn, [NOT_MERGED, ISSUE_OPEN]);
  assert.equal(out, waitsForPrereq(0));
  assert.deepEqual(writes(), []);
});

// #288: its reviews never saw the prerequisite's commits it would squash in.
test("#288: a PR stacked on a merged prerequisite is behind, with no merge", () => {
  const w = world();
  const stackedOn = { issue: PREREQ, headSha: w.sha };
  const out = runMerge(w, stackedOn, [MERGED]);
  assert.equal(out, mergeLine({ merged: false, reason: "behind" }));
  assert.deepEqual(writes(), []);
});

// #422: only the issue at the head of the merge queue is told to rebase.
test("a PR stacked on a merged prerequisite waits behind a ready issue ahead in the queue rather than rebasing", () => {
  const w = world();
  const stackedOn = { issue: PREREQ, headSha: w.sha };
  const aheadView = {
    when: `issue view ${AHEAD} `,
    stdout: JSON.stringify({ state: "OPEN", labels: [] }),
  };
  const ahead = stateListing(AHEAD, { pr: AHEAD_PR, stage: "merge" });
  const out = runMerge(w, stackedOn, [MERGED, aheadView, ahead], {
    mergeOrder: true,
    mergeQueue: [AHEAD, ISSUE],
  });
  assert.equal(
    out,
    mergeLine({
      merged: false,
      reason: "queued",
      waitingFor: AHEAD,
      waitingForPr: AHEAD_PR,
    }),
  );
  assert.deepEqual(writes(), []);
});

test("the same PR, unstacked, merges", () => {
  const w = world();
  const out = runMerge(w, null, finishReplies());
  assert.equal(out, mergeLine({ merged: true, published: true }));
  const merge = "pr merge 50 -R o/r --squash --match-head-commit".split(" ");
  assert.deepEqual(writes()[0], [...merge, w.sha]);
});
