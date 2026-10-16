// @ts-check
// The claim op through the ops CLI: its replies, the worktrees it makes, and
// what it shows on GitHub (the claim and state comments and the labels).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { bodyOf, effectNames, stateOf } from "./gh-effects.mjs";
import {
  CLAIM_MARK,
  claimReply,
  issueReply,
  LANE,
  LAPSED,
  LEASE,
  LIVE,
  NEW_STATE,
} from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  claimComment,
  commentsReply,
  configWith,
  effects,
  issueComment,
  reply,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
  writes,
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
const RESTART_LOG = /restarted .*at review/u;
// The part of a claim's reply that holds the state's log.
const LOGGED_REPLY = z.looseObject({
  state: z.looseObject({ log: z.array(z.string()) }),
});

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
  assert.deepEqual(writes(), []);
});

test("a claim refuses an issue that isn't open", () => {
  reply([issueReply(CLOSED_ISSUE, { state: "closed" })]);
  assert.deepEqual(askOps({ op: "claim", number: 41, ...LANE }), {
    ok: false,
    error: "#41 is not open",
  });
  assert.deepEqual(writes(), []);
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
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    "comment #42 role=claim",
    "comment #42 state",
    "label #42 agent:working",
    "unlabel #42 agent:needs-info",
  ]);
  assert.ok(bodyOf(claimed, "comment #42 role=claim").includes(CLAIM_MARK));
  assert.deepEqual(stateOf(claimed, "comment #42 state"), state);
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
  const got = askOps({ op: "claim", number: 43, ...LANE });
  const { log } = LOGGED_REPLY.parse(got).state;
  assert.equal(log.length, 1);
  assert.match(log.join(""), RESTART_LOG);
  const state = { ...answeredState(sha), log };
  assert.deepEqual(
    got,
    claimReply(ANSWERED_ISSUE, {
      state,
      claim: { id: 10, posted: false },
      remoteHead: sha,
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${ANSWERED_STATE} state`,
    `label #${ANSWERED_ISSUE} agent:working`,
    `label #${ANSWERED_PR} agent:working`,
    `unlabel #${ANSWERED_ISSUE} agent:needs-info`,
    `unlabel #${ANSWERED_ISSUE} agent:stopped-budget`,
  ]);
  assert.deepEqual(
    stateOf(claimed, `edit comment ${ANSWERED_STATE} state`),
    state,
  );
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
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `comment #${LAPSED_ISSUE} role=claim`,
    `edit comment ${LAPSED_STATE} state`,
    `label #${LAPSED_ISSUE} agent:working`,
    `unlabel #${LAPSED_ISSUE} agent:needs-info`,
  ]);
  assert.deepEqual(
    stateOf(claimed, `edit comment ${LAPSED_STATE} state`),
    kept,
  );
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
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${STOPPED_STATE} state`,
    `label #${STOPPED_ISSUE} agent:working`,
    `unlabel #${STOPPED_ISSUE} agent:needs-info`,
    `unlabel #${STOPPED_ISSUE} agent:stopped-budget`,
  ]);
  assert.deepEqual(
    stateOf(claimed, `edit comment ${STOPPED_STATE} state`),
    state,
  );
  assert.equal(sh(`git -C ${worktree(STOPPED_ISSUE)} rev-parse HEAD`), sha);
  assert.equal(sh(`git -C ${worktree(STOPPED_ISSUE)} status --porcelain`), "");
});
