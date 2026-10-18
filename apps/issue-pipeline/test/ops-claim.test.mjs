// @ts-check
// The version 2 claim through the ops CLI: its replies, the worktrees it
// makes, and what it shows on GitHub (the claim and state comments and the
// labels). It carries the saved state on, with only its stop lifted and this
// lane's lease; resetting a worktree to an adopted push is
// ops-claim-adopt.test.mjs's, and the code merge it records
// ops-claim-provenance.test.mjs's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { bodyOf, effectNames, stateOf } from "./gh-effects.mjs";
import {
  CLAIM_MARK,
  claimedFields,
  claimedState,
  claimReply,
  issueOf,
  issueReply,
  LANE,
  LAPSED,
  LIVE,
} from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  configWith,
  effects,
  reply,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
  writes,
} from "./ops-cli-test-kit.mjs";
import { prView } from "./ops-v2-test-kit.mjs";

const { newIssueState } = await import("../src/state.ts");

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
// The rounds a stopped issue had used before its stop.
const STOPPED_ROUND = 3;
const STOPPED_SYNCS = 2;
// The trusted-inputs revision an answered issue's questions were asked at.
const INPUTS_LENGTH = 64;
const ASKED_INPUTS = "a".repeat(INPUTS_LENGTH);

test("a claim loses to another lane's live claim", () => {
  reply([
    issueReply(LOST_ISSUE),
    commentsReply(LOST_ISSUE, [claimComment(RIVAL_CLAIM, "other", "s0", LIVE)]),
  ]);
  assert.deepEqual(askOps({ op: "claim", number: 40, ...LANE }), {
    ok: true,
    op: "claim",
    posted: false,
    commentIds: [],
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
  const state = claimedState(NEW_ISSUE);
  assert.deepEqual(
    askOps({ op: "claim", config, number: NEW_ISSUE, ...LANE }),
    claimReply(NEW_ISSUE, { state, claim: { id: NEW_CLAIM, posted: true } }),
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

test("a claim of an answered issue with a PR clears its labels and labels the PR", () => {
  const sha = sh(
    `cd ${root}/seed && git checkout -qb agent/issue-43 integration && echo 2 > g && git add g && git commit -qm work && git push -q origin agent/issue-43 && git rev-parse HEAD`,
  );
  const saved = {
    ...newIssueState(ANSWERED_ISSUE),
    stage: /** @type {const} */ ("author"),
    asked: { inputs: ASKED_INPUTS },
    pr: ANSWERED_PR,
    headSha: sha,
  };
  const comments = [
    claimComment(ANSWERED_CLAIM, "me", "s0", LIVE),
    stateComment(ANSWERED_STATE, saved),
  ];
  const labels = [
    { name: "agent:needs-info" },
    { name: "agent:stopped-conflict" },
  ];
  reply([
    issueReply(ANSWERED_ISSUE, { labels }),
    commentsReply(ANSWERED_ISSUE, comments),
    prView(ANSWERED_ISSUE, ANSWERED_PR, { headRefOid: sha }),
    commentsReply(ANSWERED_ISSUE, comments),
  ]);
  const got = askOps({ op: "claim", number: ANSWERED_ISSUE, ...LANE });
  const state = { ...saved, ...claimedFields(ANSWERED_ISSUE) };
  assert.deepEqual(
    got,
    claimReply(ANSWERED_ISSUE, {
      state,
      claim: { id: ANSWERED_CLAIM, posted: false },
      remoteHead: sha,
      issue: issueOf(ANSWERED_ISSUE, { labels }),
      comments,
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${ANSWERED_STATE} state`,
    `label #${ANSWERED_ISSUE} agent:working`,
    `label #${ANSWERED_PR} agent:working`,
    `unlabel #${ANSWERED_ISSUE} agent:needs-info`,
    `unlabel #${ANSWERED_ISSUE} agent:stopped-conflict`,
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
  const saved = {
    ...newIssueState(LAPSED_ISSUE),
    stage: /** @type {const} */ ("implement"),
    lease: { lane: "other", sweepId: "s0", at: LAPSED },
  };
  const state = stateComment(LAPSED_STATE, saved);
  const rival = claimComment(RIVAL_LAPSED_CLAIM, "other", "s0", LAPSED);
  const mine = claimComment(LAPSED_CLAIM, "me", "s0", LIVE);
  const labels = [{ name: "agent:working" }];
  reply([
    issueReply(LAPSED_ISSUE, { labels }),
    commentsReply(LAPSED_ISSUE, [rival, state]),
    { when: "issues/44/comments -f", stdout: JSON.stringify(mine) },
    commentsReply(LAPSED_ISSUE, [mine]),
    commentsReply(LAPSED_ISSUE, [state]),
  ]);
  const kept = claimedState(LAPSED_ISSUE, { stage: "implement" });
  assert.deepEqual(
    askOps({ op: "claim", number: LAPSED_ISSUE, ...LANE }),
    claimReply(LAPSED_ISSUE, {
      state: kept,
      claim: { id: LAPSED_CLAIM, posted: true },
      issue: issueOf(LAPSED_ISSUE, { labels }),
      comments: [rival, state],
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

test("a claim lifts a stopped issue's stop, resuming its stage with its counts reset", () => {
  const fresh = newIssueState(STOPPED_ISSUE);
  const saved = {
    ...fresh,
    stage: /** @type {const} */ ("stopped"),
    stoppedStage: /** @type {const} */ ("implement"),
    stopCode: "conflict",
    review: { ...fresh.review, round: STOPPED_ROUND },
    counts: { conflictFixes: 1, syncs: STOPPED_SYNCS },
    log: [`${TIME} stopped (conflict): the branch conflicts`],
  };
  const comments = [
    claimComment(STOPPED_CLAIM, "me", "s0", LIVE),
    stateComment(STOPPED_STATE, saved),
  ];
  const labels = [{ name: "agent:stopped-conflict" }];
  reply([
    issueReply(STOPPED_ISSUE, { labels }),
    commentsReply(STOPPED_ISSUE, comments),
    commentsReply(STOPPED_ISSUE, comments),
  ]);
  const state = claimedState(STOPPED_ISSUE, {
    stage: "implement",
    log: saved.log,
  });
  assert.deepEqual(
    askOps({ op: "claim", number: STOPPED_ISSUE, ...LANE }),
    claimReply(STOPPED_ISSUE, {
      state,
      claim: { id: STOPPED_CLAIM, posted: false },
      issue: issueOf(STOPPED_ISSUE, { labels }),
      comments,
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${STOPPED_STATE} state`,
    `label #${STOPPED_ISSUE} agent:working`,
    `unlabel #${STOPPED_ISSUE} agent:needs-info`,
    `unlabel #${STOPPED_ISSUE} agent:stopped-conflict`,
  ]);
  assert.deepEqual(
    stateOf(claimed, `edit comment ${STOPPED_STATE} state`),
    state,
  );
});
