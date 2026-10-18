// @ts-check
// The version 2 claim through the ops CLI: the code merge it records only
// from GitHub (a merged PR from the issue's own branch), refusing a forged
// or unreadable PR; the pipeline's own unsaved push it adopts, and the
// branch head it only reports; and the done issue it claims only to
// reconcile its completion.

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { claimMutationReplies } from "./gh-mutation-fixtures.mjs";
import { historyReply } from "./initial-write-state-fixtures.mjs";
import { requireGhReplies } from "./ops-cli-test-kit.mjs";
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

requireGhReplies();

const { askOps, reply, stateComment, writes } = kit;
const SHA_LENGTH = 40;
const MERGE_OID = "a".repeat(SHA_LENGTH);
const PR = 7;
// What the claim's refusals say.
const OTHER_BRANCH = /isn't #302's PR/u;
const UNRESOLVED = /Could not resolve/u;
const UNCONFIRMED = /doesn't confirm/u;

// Queues the reads of a claim of issue `n` that this lane already holds,
// with `saved` as its saved state, and `more` replies.
/** @param {number} n @param {Record<string, unknown>} saved @param {readonly import("./fake-gh.mjs").GhReply[]} [more] @returns {void} */
function claimWorld(n, saved, more = []) {
  const { pr } = saved;
  reply([
    openIssue(n),
    ...more,
    everyCommentsRead(n, [stateComment(1, saved), myClaim(2)]),
    ...claimMutationReplies(n, 1, z.number().nullable().parse(pr)),
  ]);
}

// The parts of a claim's reply, and of a saved state, the tests read.
const STATE = z.looseObject({
  stage: z.string(),
  headSha: z.string().nullable(),
  verifiedSha: z.string().nullable(),
  codeMerged: z.unknown(),
  merged: z.unknown(),
  review: z.looseObject({ verdict: z.string().nullable() }),
});
const CLAIMED = z.looseObject({
  ok: z.boolean(),
  state: STATE,
  claim: z.unknown(),
  issueFile: z.unknown(),
  remoteHead: z.unknown(),
  branchChanged: z.unknown().optional(),
  lost: z.unknown().optional(),
});
const FAILED = z.looseObject({ ok: z.boolean(), error: z.string() });

test("a claim records the code merge GitHub reports for the issue's own PR", () => {
  const n = 301;
  claimWorld(
    n,
    v2State(n, { stage: "merge", pr: PR, headSha: "b".repeat(SHA_LENGTH) }),
    [prView(n, PR, { state: "MERGED", mergeCommit: { oid: MERGE_OID } })],
  );
  const won = CLAIMED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  const { state } = won;
  assert.deepEqual(state.codeMerged, { pr: PR, sha: MERGE_OID });
  assert.equal(state.stage, "merge");
  assert.equal(won.branchChanged, undefined);
  assert.deepEqual(won.claim, { id: 2, posted: false });
  assert.equal(typeof won.issueFile, "string");
  assert.deepEqual(STATE.parse(savedStates().at(-1)).codeMerged, {
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
  const failed = FAILED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, OTHER_BRANCH);
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
  const failed = FAILED.parse(askOps({ op: "claim", number: n, ...LANE }));
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
  const failed = FAILED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, UNRESOLVED);
  assert.deepEqual(writes(), []);
});

test("a claim refuses a merged PR without a merge commit", () => {
  const n = 305;
  claimWorld(n, v2State(n, { pr: PR }), [
    prView(n, PR, { state: "MERGED", mergeCommit: null }),
  ]);
  const failed = FAILED.parse(askOps({ op: "claim", number: n, ...LANE }));
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
  const failed = FAILED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, UNCONFIRMED);
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
    [historyReply(n)],
  );
  const won = CLAIMED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  const { state } = won;
  assert.equal(state.stage, "review");
  assert.equal(state.headSha, pushed);
  assert.equal(state.verifiedSha, null);
  assert.equal(state.review.verdict, null);
  assert.equal(won.remoteHead, pushed);
  assert.equal(won.branchChanged, undefined);
});

test("a claim reports a branch head the pipeline didn't push, leaving the state", () => {
  const n = 308;
  const saved = commitOnOrigin(`agent/issue-${n}`, "f308a");
  const foreign = commitOnOrigin(`agent/issue-${n}`, "f308b");
  claimWorld(n, v2State(n, { stage: "review", headSha: saved }), [
    historyReply(n),
  ]);
  const won = CLAIMED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  assert.equal(won.lost, undefined);
  assert.deepEqual(won.branchChanged, { saved, remote: foreign });
  const { state } = won;
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
  const won = CLAIMED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.equal(won.ok, true);
  const { state } = won;
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
  const failed = FAILED.parse(askOps({ op: "claim", number: n, ...LANE }));
  assert.deepEqual(failed, { ok: false, error: "#310 is done" });
  assert.deepEqual(writes(), []);
});
