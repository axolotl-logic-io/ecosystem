// @ts-check
// The version 2 claim through the ops CLI: the code merge it records only
// from GitHub (a merged PR from the issue's own branch), refusing a forged
// or unreadable PR; the pipeline's own unsaved push it adopts, and the
// branch head it only reports; and the done issue it claims only to
// reconcile its completion.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitOnOrigin,
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  openIssue,
  prView,
  recordPipelinePush,
  savedStates,
  v2State,
} from "./ops-v2-test-kit.mjs";

const { askOps, reply, stateComment, writes } = kit;
const MERGE_OID = "a".repeat(40);
const PR = 7;

// Queues the reads of a claim of issue `n` that this lane already holds,
// with `saved` as its saved state, and `more` replies.
/** @param {number} n @param {object} saved @param {readonly import("./fake-gh.mjs").GhReply[]} [more] @returns {void} */
function claimWorld(n, saved, more = []) {
  reply([
    openIssue(n),
    ...more,
    everyCommentsRead(n, [stateComment(1, saved), myClaim(2)]),
  ]);
}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return /** @type {Record<string, unknown>} */ (value);
}

test("a claim records the code merge GitHub reports for the issue's own PR", () => {
  const n = 301;
  claimWorld(
    n,
    v2State(n, { stage: "merge", pr: PR, headSha: "b".repeat(40) }),
    [prView(n, PR, { state: "MERGED", mergeCommit: { oid: MERGE_OID } })],
  );
  const won = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  const state = record(won.state);
  assert.deepEqual(state.codeMerged, { pr: PR, sha: MERGE_OID });
  assert.equal(state.stage, "merge");
  assert.equal(won.branchChanged, undefined);
  assert.deepEqual(record(won.claim), { id: 2, posted: false });
  assert.equal(typeof won.issueFile, "string");
  assert.deepEqual(record(savedStates().at(-1)).codeMerged, {
    pr: PR,
    sha: MERGE_OID,
  });
});

test("a claim refuses a PR from another branch as the issue's merge", () => {
  const n = 302;
  claimWorld(n, v2State(n, { pr: PR }), [
    prView(n, PR, {
      state: "MERGED",
      mergeCommit: { oid: MERGE_OID },
      headRefName: "agent/issue-999",
    }),
  ]);
  const failed = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /isn't #302's PR/u);
  assert.deepEqual(savedStates(), []);
});

test("a claim refuses a fork's PR of the same branch name", () => {
  const n = 303;
  claimWorld(n, v2State(n, { pr: PR }), [
    prView(n, PR, {
      state: "MERGED",
      mergeCommit: { oid: MERGE_OID },
      isCrossRepository: true,
    }),
  ]);
  const failed = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.deepEqual(savedStates(), []);
});

test("a claim fails, never assuming a merge, when GitHub can't say", () => {
  const n = 304;
  claimWorld(n, v2State(n, { pr: PR }), [
    {
      when: `pr view ${PR} `,
      stderr:
        "GraphQL: Could not resolve to a PullRequest with the number of 7.",
      code: 1,
      keep: true,
    },
  ]);
  const failed = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /Could not resolve/u);
  assert.deepEqual(writes(), []);
});

test("a claim refuses a merged PR without a merge commit", () => {
  const n = 305;
  claimWorld(n, v2State(n, { pr: PR }), [
    prView(n, PR, { state: "MERGED", mergeCommit: null }),
  ]);
  const failed = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.deepEqual(savedStates(), []);
});

test("a claim refuses a recorded code merge GitHub no longer confirms", () => {
  const n = 306;
  const saved = v2State(n, {
    stage: "review",
    pr: PR,
    codeMerged: { pr: PR, sha: MERGE_OID },
  });
  claimWorld(n, saved, [prView(n, PR)]);
  const failed = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.match(String(failed.error), /doesn't confirm/u);
  assert.deepEqual(savedStates(), []);
});

test("a claim adopts the pipeline's own unsaved push and sends a merge back to review", () => {
  const n = 307;
  const saved = commitOnOrigin(`agent/issue-${n}`, "f307a");
  const pushed = commitOnOrigin(`agent/issue-${n}`, "f307b");
  recordPipelinePush(n, pushed, "sync-base");
  claimWorld(
    n,
    v2State(n, {
      stage: "merge",
      headSha: saved,
      verifiedSha: saved,
      review: {
        round: 1,
        verdict: "approve",
        commentId: null,
        findings: [],
        revision: { code: saved, wiki: null, inputs: "x" },
      },
    }),
  );
  const won = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  const state = record(won.state);
  assert.equal(state.stage, "review");
  assert.equal(state.headSha, pushed);
  assert.equal(state.verifiedSha, null);
  assert.equal(record(state.review).verdict, null);
  assert.equal(won.remoteHead, pushed);
  assert.equal(won.branchChanged, undefined);
});

test("a claim reports a branch head the pipeline didn't push, leaving the state", () => {
  const n = 308;
  const saved = commitOnOrigin(`agent/issue-${n}`, "f308a");
  const foreign = commitOnOrigin(`agent/issue-${n}`, "f308b");
  claimWorld(n, v2State(n, { stage: "review", headSha: saved }));
  const won = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  assert.equal(won.lost, undefined);
  assert.deepEqual(won.branchChanged, { saved, remote: foreign });
  const state = record(won.state);
  assert.equal(state.stage, "review");
  assert.equal(state.headSha, saved);
});

test("a claim of a done issue that saved its merge reconciles it, done and unlabelled", () => {
  const n = 309;
  const merged = { code: MERGE_OID, wiki: null, inputs: "x" };
  claimWorld(
    n,
    v2State(n, {
      stage: "done",
      pr: PR,
      merged,
      codeMerged: { pr: PR, sha: MERGE_OID },
    }),
    [prView(n, PR, { state: "MERGED", mergeCommit: { oid: MERGE_OID } })],
  );
  const won = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  const state = record(won.state);
  assert.equal(state.stage, "done");
  assert.deepEqual(state.merged, merged);
  assert.equal(
    writes().some((args) => args.join(" ").includes("agent:working")),
    false,
  );
});

test("a claim of a done issue with no saved merge fails", () => {
  const n = 310;
  claimWorld(n, v2State(n, { stage: "done" }));
  const failed = record(askOps({ op: "claim", number: n, ...LANE }));
  assert.deepEqual(failed, { ok: false, error: "#310 is done" });
  assert.deepEqual(writes(), []);
});
