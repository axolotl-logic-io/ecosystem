// @ts-check
// The merge op's own merge order, with no orchestrator queue: only an issue
// with an older PR at a holding stage (accept, security or merge) holds the
// merge; one at sync or checks doesn't (#358).
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

// #7 and its PR, and the working issue #9 with an older PR and a live lease.
const ISSUE = 7;
const PR = 50;
const AHEAD = 9;
const AHEAD_PR = 40;
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

// Merges #7 with merge order and no queue while #9 is at `stage`, after
// queuing `replies` for what follows the order's reads.
/** @param {World} w @param {string} stage @param {GhReply[]} replies @returns {string} */
function mergeBeside(w, stage, replies) {
  const ahead = { pr: AHEAD_PR, stage, lease: { at: hoursFromNow(0) } };
  fakeGh.reply([
    viewReply(w.sha),
    {
      when: "issue list",
      stdout: JSON.stringify([{ number: AHEAD, labels: [] }]),
    },
    stateListing(AHEAD, ahead),
    ...replies,
  ]);
  return ask(w, {
    op: "merge",
    number: ISSUE,
    state: STATE,
    expectedSha: w.sha,
    summary: "All good.",
    mergeOrder: true,
  });
}

for (const stage of ["sync", "checks"]) {
  test(`an older PR at ${stage} doesn't hold the merge`, () => {
    const w = world();
    const out = mergeBeside(w, stage, finishReplies());
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
  });
}

for (const stage of ["accept", "security", "merge"]) {
  test(`an older PR at ${stage} holds the merge`, () => {
    const w = world();
    const out = mergeBeside(w, stage, []);
    assert.equal(
      out,
      replyLine({
        ok: true,
        op: "merge",
        posted: 0,
        merged: false,
        reason: "queued",
        waitingFor: AHEAD,
        waitingForPr: AHEAD_PR,
      }),
    );
    assert.deepEqual(writes(), []);
  });
}
