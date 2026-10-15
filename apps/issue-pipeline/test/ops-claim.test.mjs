// @ts-check
// The claim op through the ops CLI, pinned to the replies, gh calls and
// worktrees it made before it moved to src/ops/claim.ts (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  claimReply,
  getIssue,
  issueReply,
  LANE,
  LAPSED,
  LEASE,
  LIVE,
  listOpenPrs,
  NEW_STATE,
  patchState,
  postClaim,
  postState,
} from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  calls,
  claimComment,
  commentsReply,
  configWith,
  ghCalls,
  issueComment,
  reply,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

const SETUP_MARK = "setup-ran";
// Each test's issue, and the ids of the claim and state comments on it.
const LOST_ISSUE = 40;
const RIVAL_CLAIM = 9;
const CLOSED_ISSUE = 41;
const NEW_ISSUE = 42;
const NEW_CLAIM = 100;
const ANSWERED_ISSUE = 43;
const ANSWERED_CLAIM = 10;
const ANSWERED_STATE = 11;
const ANSWERED_PR = 50;
const LAPSED_ISSUE = 44;
const LAPSED_STATE = 12;
const LAPSED_CLAIM = 101;
const RIVAL_LAPSED_CLAIM = 13;
const STOPPED_ISSUE = 45;
const STOPPED_CLAIM = 14;
const STOPPED_STATE = 15;
const ANSWER = 16;

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

test("a claim loses to another lane's live claim", () => {
  reply([
    issueReply(LOST_ISSUE),
    commentsReply(LOST_ISSUE, [claimComment(RIVAL_CLAIM, "other", "s0", LIVE)]),
  ]);
  assert.deepEqual(askOps({ op: "claim", number: 40, ...LANE }), {
    ok: true,
    op: "claim",
    posted: false,
    lost: true,
    holder: "other",
  });
  assert.deepEqual(calls(), [
    getIssue(LOST_ISSUE),
    ghCalls.listComments(LOST_ISSUE),
  ]);
});

test("a claim refuses an issue that isn't open", () => {
  reply([issueReply(CLOSED_ISSUE, { state: "closed" })]);
  assert.deepEqual(askOps({ op: "claim", number: 41, ...LANE }), {
    ok: false,
    error: "#41 is not open",
  });
  assert.deepEqual(calls(), [
    getIssue(CLOSED_ISSUE),
    ghCalls.listComments(CLOSED_ISSUE),
  ]);
});

test("a claim of new work posts its claim, makes the worktree and runs setup", () => {
  const config = configWith({
    commands: { test: "true", setup: `touch ${SETUP_MARK}` },
  });
  const mine = claimComment(NEW_CLAIM, "me", "s0", LIVE);
  reply([
    issueReply(NEW_ISSUE),
    commentsReply(NEW_ISSUE, []),
    { when: "issues/42/comments -f", stdout: JSON.stringify(mine) },
    commentsReply(NEW_ISSUE, [mine]),
  ]);
  const state = { ...NEW_STATE, number: 42 };
  assert.deepEqual(
    askOps({ op: "claim", config, number: 42, ...LANE }),
    claimReply(NEW_ISSUE, {
      state,
      claim: { id: 100, posted: true, waited: 0 },
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(NEW_ISSUE),
    ghCalls.listComments(NEW_ISSUE),
    postClaim(NEW_ISSUE),
    ghCalls.label(NEW_ISSUE, "agent:working"),
    ghCalls.listComments(NEW_ISSUE),
    ghCalls.unlabel(NEW_ISSUE, "agent:needs-info"),
    ghCalls.label(NEW_ISSUE, "agent:working"),
    ghCalls.listComments(NEW_ISSUE),
    postState(NEW_ISSUE, state),
  ]);
  assert.ok(fs.existsSync(path.join(worktree(NEW_ISSUE), SETUP_MARK)));
  assert.ok(fs.existsSync(path.join(runDir(NEW_ISSUE), "setup-at-claim.log")));
});

// startState's restart of #43 at review, on its PR's branch at `sha`.
/** @param {string} sha @returns {object} */
function answeredState(sha) {
  return {
    ...NEW_STATE,
    number: 43,
    stage: "review",
    pr: 50,
    headSha: sha,
    log: [
      `${TIME} restarted on the existing branch (PR #50) at review after answered questions; limits reset`,
    ],
    implemented: true,
  };
}

test("a claim of an answered issue with a PR clears its labels and labels the PR", () => {
  sh(
    `cd ${root}/seed && git checkout -qb agent/issue-43 integration && echo 2 > g && git add g && git commit -qm work && git push -q origin agent/issue-43`,
  );
  const comments = [
    claimComment(ANSWERED_CLAIM, "me", "s0", LIVE),
    stateComment(ANSWERED_STATE, {
      stage: "triage",
      questionsAt: LAPSED,
      lease: null,
      pr: 50,
    }),
    issueComment(ANSWER, "answer", ALLOWED, LIVE),
  ];
  reply([
    issueReply(ANSWERED_ISSUE, {
      labels: [{ name: "agent:needs-info" }, { name: "agent:stopped-budget" }],
    }),
    commentsReply(ANSWERED_ISSUE, comments),
    { when: "pr list", stdout: JSON.stringify([{ number: 50 }]) },
    commentsReply(ANSWERED_ISSUE, comments),
  ]);
  const sha = sh(`git -C ${root}/seed rev-parse HEAD`);
  const state = answeredState(sha);
  assert.deepEqual(
    askOps({ op: "claim", number: 43, ...LANE }),
    claimReply(ANSWERED_ISSUE, {
      state,
      claim: { id: 10, posted: false },
      remoteHead: sha,
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(ANSWERED_ISSUE),
    ghCalls.listComments(ANSWERED_ISSUE),
    ghCalls.collaborator(ALLOWED),
    listOpenPrs(ANSWERED_ISSUE),
    ghCalls.unlabel(ANSWERED_ISSUE, "agent:needs-info"),
    ghCalls.unlabel(ANSWERED_ISSUE, "agent:stopped-budget"),
    ghCalls.label(ANSWERED_ISSUE, "agent:working"),
    ghCalls.label(ANSWERED_PR, "agent:working"),
    ["api", "repos/o/r/issues/50/labels"],
    ghCalls.listComments(ANSWERED_ISSUE),
    patchState(ANSWERED_ISSUE, ANSWERED_STATE, state),
  ]);
});

test("a claim that resumes a lapsed lease keeps its stage and its worktree", () => {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-44 ${worktree(LAPSED_ISSUE)} origin/integration && touch ${worktree(LAPSED_ISSUE)}/wip`,
  );
  const state = stateComment(LAPSED_STATE, {
    stage: "implement",
    lease: { lane: "other", sweepId: "s0", at: LAPSED },
    pr: null,
  });
  const mine = claimComment(LAPSED_CLAIM, "me", "s0", LIVE);
  reply([
    issueReply(LAPSED_ISSUE, { labels: [{ name: "agent:working" }] }),
    commentsReply(LAPSED_ISSUE, [
      claimComment(RIVAL_LAPSED_CLAIM, "other", "s0", LAPSED),
      state,
    ]),
    { when: "issues/44/comments -f", stdout: JSON.stringify(mine) },
    commentsReply(LAPSED_ISSUE, [mine]),
    commentsReply(LAPSED_ISSUE, [state]),
  ]);
  const kept = { pr: null, stage: "implement", lease: LEASE };
  assert.deepEqual(
    askOps({ op: "claim", number: 44, ...LANE }),
    claimReply(LAPSED_ISSUE, {
      state: kept,
      claim: { id: 101, posted: true, waited: 0 },
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(LAPSED_ISSUE),
    ghCalls.listComments(LAPSED_ISSUE),
    postClaim(LAPSED_ISSUE),
    ghCalls.label(LAPSED_ISSUE, "agent:working"),
    ghCalls.listComments(LAPSED_ISSUE),
    ghCalls.unlabel(LAPSED_ISSUE, "agent:needs-info"),
    ghCalls.label(LAPSED_ISSUE, "agent:working"),
    ghCalls.listComments(LAPSED_ISSUE),
    patchState(LAPSED_ISSUE, LAPSED_STATE, kept),
  ]);
  assert.ok(fs.existsSync(path.join(worktree(LAPSED_ISSUE), "wip")));
});

// A stopped #45 whose worktree has uncommitted edits, and whose branch on
// GitHub has a commit the worktree lacks.
/** @returns {string} */
function stoppedWithStaleWorktree() {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-45 ${worktree(STOPPED_ISSUE)} origin/integration && echo edit > ${worktree(STOPPED_ISSUE)}/f && touch ${worktree(STOPPED_ISSUE)}/wip`,
  );
  sh(
    `cd ${root}/seed && git checkout -qb agent/issue-45 integration && echo 3 > h && git add h && git commit -qm work && git push -q origin agent/issue-45`,
  );
  return sh(`git -C ${root}/seed rev-parse HEAD`);
}

test("a claim restarts a stopped issue and resets its worktree to the branch", () => {
  const sha = stoppedWithStaleWorktree();
  const stoppedAt = `${TIME} stopped: budget`;
  const comments = [
    claimComment(STOPPED_CLAIM, "me", "s0", LIVE),
    stateComment(STOPPED_STATE, {
      stage: "stopped",
      lease: null,
      pr: null,
      log: [stoppedAt],
    }),
  ];
  reply([
    issueReply(STOPPED_ISSUE, { labels: [{ name: "agent:stopped-budget" }] }),
    commentsReply(STOPPED_ISSUE, comments),
    { when: "pr list", stdout: "[]" },
    commentsReply(STOPPED_ISSUE, comments),
  ]);
  const state = { ...NEW_STATE, number: 45, headSha: sha, log: [stoppedAt] };
  assert.deepEqual(
    askOps({ op: "claim", number: 45, ...LANE }),
    claimReply(STOPPED_ISSUE, {
      state,
      claim: { id: 14, posted: false },
      remoteHead: sha,
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(STOPPED_ISSUE),
    ghCalls.listComments(STOPPED_ISSUE),
    listOpenPrs(STOPPED_ISSUE),
    ghCalls.unlabel(STOPPED_ISSUE, "agent:needs-info"),
    ghCalls.unlabel(STOPPED_ISSUE, "agent:stopped-budget"),
    ghCalls.label(STOPPED_ISSUE, "agent:working"),
    ghCalls.listComments(STOPPED_ISSUE),
    patchState(STOPPED_ISSUE, STOPPED_STATE, state),
  ]);
  assert.equal(sh(`git -C ${worktree(STOPPED_ISSUE)} rev-parse HEAD`), sha);
  assert.equal(sh(`git -C ${worktree(STOPPED_ISSUE)} status --porcelain`), "");
});
