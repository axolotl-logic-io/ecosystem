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
import { z } from "zod";
import { loseOwnership } from "../fake-ownership.mjs";
import { effectNames, lastStateOf, stateOf } from "../gh-effects-test-kit.mjs";
import {
  claimMutationReplies,
  collaboratorReply,
} from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import {
  claimedFields,
  claimedState,
  claimReply,
  issueOf,
  issueReply,
  LANE,
  LAPSED,
  LIVE,
  ownerClaim,
} from "../ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  configWith,
  effects,
  reply,
  requireGhReplies,
  root,
  runDir,
  savedStateComment,
  sh,
  TIME,
  worktree,
  writes,
} from "../ops-cli-test-kit.mjs";
import { prView } from "../ops-v2-test-kit.mjs";

requireGhReplies();

const { newIssueState } = await import("../../src/state.ts");

const SETUP_MARK = "setup-ran";
const REFUSED = z.object({ ok: z.literal(false), error: z.string() });
// What an owner whose issue a successor took reads (coordination-records.ts).
const RELEASED = /released instance cannot request again/u;
// Each test's issue, and the ids of the claim and state comments on it.
const LOST_ISSUE = 40;
const CLOSED_ISSUE = 41;
const NEW_ISSUE = 42;
// The id GitHub gives the state comment a new issue's claim posts.
const STATE_ID = 700_001;
const ANSWERED_ISSUE = 43;
const ANSWERED_CLAIM = 10;
const ANSWERED_STATE = 11;
const ANSWERED_PR = 50;
const LAPSED_ISSUE = 44;
const LAPSED_STATE = 12;
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

// A job claims only once it owns the issue (#167); a claim whose issue
// another invocation takes after its ownership check writes nothing (#169).
test("a claim loses to another invocation that takes the issue, writing nothing", () => {
  reply([
    collaboratorReply("o/r", "alice"),
    historyReply(LOST_ISSUE),
    issueReply(LOST_ISSUE),
    commentsReply(LOST_ISSUE, [
      savedStateComment(1, newIssueState(LOST_ISSUE)),
    ]),
  ]);
  loseOwnership();
  const refused = REFUSED.parse(
    askOps({ op: "claim", number: LOST_ISSUE, ...LANE }),
  );
  assert.match(refused.error, RELEASED);
  assert.deepEqual(writes(), []);
});

test("a claim refuses an issue that isn't open", () => {
  reply([
    collaboratorReply("o/r", "alice"),
    historyReply(CLOSED_ISSUE),
    issueReply(CLOSED_ISSUE, { state: "closed" }),
    commentsReply(CLOSED_ISSUE, []),
  ]);
  assert.deepEqual(askOps({ op: "claim", number: 41, ...LANE }), {
    ok: false,
    error: "#41 is not open",
  });
  assert.deepEqual(writes(), []);
});

test("a claim of new work saves its receipt, makes the worktree and runs setup", () => {
  const config = configWith({
    commands: { test: "true", setup: `touch ${SETUP_MARK}` },
  });
  reply([
    historyReply(NEW_ISSUE),
    issueReply(NEW_ISSUE),
    { ...commentsReply(NEW_ISSUE, []), keep: true },
    ...claimMutationReplies(NEW_ISSUE, NEW_ISSUE, null),
  ]);
  const got = askOps({ op: "claim", config, number: NEW_ISSUE, ...LANE });
  const state = claimedState(NEW_ISSUE);
  assert.deepEqual(got, claimReply(NEW_ISSUE, { state, claim: ownerClaim() }));
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    "comment #42 state",
    `edit comment ${STATE_ID} state`,
    "label #42 agent:working",
    "unlabel #42 agent:needs-info",
  ]);
  assert.deepEqual(stateOf(claimed, `edit comment ${STATE_ID} state`), state);
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
    savedStateComment(ANSWERED_STATE, saved),
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
    ...claimMutationReplies(ANSWERED_ISSUE, ANSWERED_STATE, ANSWERED_PR, [
      "agent:stopped-conflict",
    ]),
  ]);
  const got = askOps({ op: "claim", number: ANSWERED_ISSUE, ...LANE });
  const state = { ...saved, ...claimedFields(ANSWERED_ISSUE) };
  assert.deepEqual(
    got,
    claimReply(ANSWERED_ISSUE, {
      state,
      claim: ownerClaim(),
      remoteHead: sha,
      issue: issueOf(ANSWERED_ISSUE, { labels }),
      comments,
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${ANSWERED_STATE} state`,
    `edit comment ${ANSWERED_STATE} state`,
    `label #${ANSWERED_ISSUE} agent:working`,
    `label #${ANSWERED_PR} agent:working`,
    `unlabel #${ANSWERED_ISSUE} agent:needs-info`,
    `unlabel #${ANSWERED_ISSUE} agent:stopped-conflict`,
  ]);
  assert.deepEqual(
    lastStateOf(claimed, `edit comment ${ANSWERED_STATE} state`),
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
  const state = savedStateComment(LAPSED_STATE, saved);
  const rival = claimComment(RIVAL_LAPSED_CLAIM, "other", "s0", LAPSED);
  const labels = [{ name: "agent:working" }];
  reply([
    historyReply(LAPSED_ISSUE),
    issueReply(LAPSED_ISSUE, { labels }),
    commentsReply(LAPSED_ISSUE, [rival, state]),
    ...claimMutationReplies(LAPSED_ISSUE, LAPSED_STATE, null),
  ]);
  const got = askOps({ op: "claim", number: LAPSED_ISSUE, ...LANE });
  const kept = claimedState(LAPSED_ISSUE, { stage: "implement" });
  assert.deepEqual(
    got,
    claimReply(LAPSED_ISSUE, {
      state: kept,
      claim: ownerClaim(),
      issue: issueOf(LAPSED_ISSUE, { labels }),
      comments: [rival, state],
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${LAPSED_STATE} state`,
    `edit comment ${LAPSED_STATE} state`,
    `label #${LAPSED_ISSUE} agent:working`,
    `unlabel #${LAPSED_ISSUE} agent:needs-info`,
  ]);
  assert.deepEqual(
    lastStateOf(claimed, `edit comment ${LAPSED_STATE} state`),
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
    savedStateComment(STOPPED_STATE, saved),
  ];
  const labels = [{ name: "agent:stopped-conflict" }];
  reply([
    historyReply(STOPPED_ISSUE),
    issueReply(STOPPED_ISSUE, { labels }),
    commentsReply(STOPPED_ISSUE, comments),
    commentsReply(STOPPED_ISSUE, comments),
    ...claimMutationReplies(STOPPED_ISSUE, STOPPED_STATE, null, [
      "agent:stopped-conflict",
    ]),
  ]);
  const got = askOps({ op: "claim", number: STOPPED_ISSUE, ...LANE });
  const state = claimedState(STOPPED_ISSUE, {
    stage: "implement",
    log: saved.log,
  });
  assert.deepEqual(
    got,
    claimReply(STOPPED_ISSUE, {
      state,
      claim: ownerClaim(),
      issue: issueOf(STOPPED_ISSUE, { labels }),
      comments,
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `edit comment ${STOPPED_STATE} state`,
    `edit comment ${STOPPED_STATE} state`,
    `label #${STOPPED_ISSUE} agent:working`,
    `unlabel #${STOPPED_ISSUE} agent:needs-info`,
    `unlabel #${STOPPED_ISSUE} agent:stopped-conflict`,
  ]);
  assert.deepEqual(
    lastStateOf(claimed, `edit comment ${STOPPED_STATE} state`),
    state,
  );
});
