// A claim that carries on from a saved state whose head the branch on GitHub
// no longer has: it adopts the head only when this machine recorded pushing
// it, as after a push whose state save failed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  claimReply,
  issueReply,
  LANE,
  LEASE,
  LIVE,
} from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

const SHORT_SHA = 8;
// The issues: one with a matching push record, one whose record names another
// head, one with no record and then an unreadable one, one saved before the
// review, one whose record is a CI fix's push, one whose record is a stage
// job's exit push from open-pr, one with an exit push after the review, and
// two whose record is a pipeline_commit push, from implement and from checks.
const ADOPTED = 61;
const OTHER_RECORD = 62;
const NO_RECORD = 63;
const BEFORE_REVIEW = 64;
const CI_FIX = 65;
const EXIT_PUSHED = 66;
const EXIT_PUSHED_LATE = 67;
const COMMIT_PUSHED = 68;
const COMMIT_PUSHED_LATE = 69;
// Each issue's claim comment id; its state comment follows it.
const CLAIM_IDS = 10;

/**
 * A state saved at checks, as movedBranch saves it.
 * @typedef {{ stage: string, lease: null, pr: null, headSha: string, passedSha: string | null, log: string[] }} Saved
 */

const ADOPTED_LOG = /adopted/u;
// The state's log, which records an adopted push.
const LOGGED = z.looseObject({ log: z.array(z.string()) });

// The part of a claim's reply these tests read.
const CLAIM_REPLY = z.looseObject({
  state: z.unknown(),
  remoteHead: z.unknown(),
});

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Issue `n`, saved at checks with its worktree on the base, and a branch on
// GitHub one commit past the saved head. Returns the saved state and the
// branch's head.
/** @param {number} n @returns {{ saved: Saved, remote: string }} */
function movedBranch(n) {
  const wt = worktree(n);
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${wt} origin/integration`,
  );
  const old = sh(`git -C ${wt} rev-parse HEAD`);
  sh(
    `cd ${root}/seed && git checkout -qb agent/issue-${n} integration && echo ${n} > a${n} && git add a${n} && git commit -qm work && git push -q origin agent/issue-${n}`,
  );
  const remote = sh(`git -C ${root}/seed rev-parse HEAD`);
  /** @type {Saved} */
  const saved = {
    stage: "checks",
    lease: null,
    pr: null,
    headSha: old,
    passedSha: old,
    log: [],
  };
  return { saved, remote };
}

// Records, as the ops would before a push, that `sha` was pushed for `n`.
/** @param {number} n @param {string} sha @param {string} [op] @returns {void} */
function recordPush(n, sha, op = "finish-sync") {
  fs.mkdirSync(runDir(n), { recursive: true });
  const record = JSON.stringify({ sha, op, at: TIME });
  fs.writeFileSync(path.join(runDir(n), "pushed.json"), record);
}

// Claims `n`, which this lane already holds, from the saved state `saved`.
/** @param {number} n @param {Saved} saved @returns {z.infer<typeof CLAIM_REPLY>} */
function claimSaved(n, saved) {
  const comments = [
    claimComment(n * CLAIM_IDS, "me", "s0", LIVE),
    stateComment(n * CLAIM_IDS + 1, saved),
  ];
  reply([
    issueReply(n),
    commentsReply(n, comments),
    commentsReply(n, comments),
  ]);
  return CLAIM_REPLY.parse(askOps({ op: "claim", number: n, ...LANE }));
}

/** @param {number} n @returns {string} */
function head(n) {
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

test("a claim adopts the head this machine recorded pushing", () => {
  const { saved, remote } = movedBranch(ADOPTED);
  recordPush(ADOPTED, remote);
  const got = claimSaved(ADOPTED, saved);
  const { log } = LOGGED.parse(got.state);
  assert.equal(log.length, 1);
  assert.match(log.join(""), ADOPTED_LOG);
  assert.ok(log.join("").includes(remote.slice(0, SHORT_SHA)));
  const state = {
    ...saved,
    headSha: remote,
    passedSha: null,
    stage: "sync",
    log,
    lease: LEASE,
  };
  const claim = { id: ADOPTED * CLAIM_IDS, posted: false };
  const want = claimReply(ADOPTED, { state, claim, remoteHead: remote });
  assert.deepEqual(got, want);
  assert.equal(head(ADOPTED), remote);
});

test("a claim keeps the saved head when the record names another", () => {
  const { saved, remote } = movedBranch(OTHER_RECORD);
  recordPush(OTHER_RECORD, saved.headSha);
  const kept = claimSaved(OTHER_RECORD, saved);
  assert.deepEqual(kept.state, { ...saved, lease: LEASE });
  assert.equal(kept.remoteHead, remote);
  assert.equal(head(OTHER_RECORD), saved.headSha);
});

test("a claim keeps the saved head with no record or an unreadable one", () => {
  const { saved, remote } = movedBranch(NO_RECORD);
  const missing = claimSaved(NO_RECORD, saved);
  assert.deepEqual(missing.state, { ...saved, lease: LEASE });
  assert.equal(missing.remoteHead, remote);
  fs.mkdirSync(runDir(NO_RECORD), { recursive: true });
  fs.writeFileSync(path.join(runDir(NO_RECORD), "pushed.json"), "{not json");
  const malformed = claimSaved(NO_RECORD, saved);
  assert.deepEqual(malformed.state, { ...saved, lease: LEASE });
  assert.equal(head(NO_RECORD), saved.headSha);
});

// Adopting open-pr's push from a state saved at implement would send the
// branch to sync with no code review.
test("a claim keeps the saved head when it was saved before the review", () => {
  const moved = movedBranch(BEFORE_REVIEW);
  const saved = { ...moved.saved, stage: "implement", passedSha: null };
  recordPush(BEFORE_REVIEW, moved.remote, "open-pr");
  const kept = claimSaved(BEFORE_REVIEW, saved);
  assert.deepEqual(kept.state, { ...saved, lease: LEASE });
  assert.equal(kept.remoteHead, moved.remote);
  assert.equal(head(BEFORE_REVIEW), saved.headSha);
});

// A CI fix pushes at checks and is reviewed only after the push, so adopting
// its push would send the fix to sync without its check-fix review.
test("a claim keeps the saved head when the record is a CI fix's push", () => {
  const { saved, remote } = movedBranch(CI_FIX);
  recordPush(CI_FIX, remote, "push");
  const kept = claimSaved(CI_FIX, saved);
  assert.deepEqual(kept.state, { ...saved, lease: LEASE });
  assert.equal(kept.remoteHead, remote);
  assert.equal(head(CI_FIX), saved.headSha);
});

// A stage job pushes, as it exits, the commits its checkout holds past its
// last state save (#315). From a state saved at open-pr the review that
// follows reads every commit, so the claim adopts the head at that stage.
test("a claim adopts a job's exit push at open-pr, keeping the stage", () => {
  const moved = movedBranch(EXIT_PUSHED);
  const saved = { ...moved.saved, stage: "open-pr", passedSha: null };
  recordPush(EXIT_PUSHED, moved.remote, "exit-push");
  const got = claimSaved(EXIT_PUSHED, saved);
  const { log } = LOGGED.parse(got.state);
  assert.equal(log.length, 1);
  assert.match(log.join(""), ADOPTED_LOG);
  const state = { ...saved, headSha: moved.remote, log, lease: LEASE };
  const claim = { id: EXIT_PUSHED * CLAIM_IDS, posted: false };
  const remoteHead = moved.remote;
  assert.deepEqual(got, claimReply(EXIT_PUSHED, { state, claim, remoteHead }));
  assert.equal(head(EXIT_PUSHED), moved.remote);
});

// At checks the review is behind it: adopting the exit push would merge
// commits no reviewer read.
test("a claim keeps the saved head for an exit push after the review", () => {
  const { saved, remote } = movedBranch(EXIT_PUSHED_LATE);
  recordPush(EXIT_PUSHED_LATE, remote, "exit-push");
  const kept = claimSaved(EXIT_PUSHED_LATE, saved);
  assert.deepEqual(kept.state, { ...saved, lease: LEASE });
  assert.equal(kept.remoteHead, remote);
  assert.equal(head(EXIT_PUSHED_LATE), saved.headSha);
});

// pipeline_commit pushes an interrupted implementer's commits as it makes
// them (#303): the claim adopts them where it adopts an exit push.
test("a claim adopts a pipeline_commit push at implement, keeping the stage", () => {
  const moved = movedBranch(COMMIT_PUSHED);
  const saved = { ...moved.saved, stage: "implement", passedSha: null };
  recordPush(COMMIT_PUSHED, moved.remote, "pipeline-commit");
  const got = claimSaved(COMMIT_PUSHED, saved);
  const { log } = LOGGED.parse(got.state);
  assert.match(log.join(""), ADOPTED_LOG);
  const state = { ...saved, headSha: moved.remote, log, lease: LEASE };
  assert.deepEqual(got.state, state);
  assert.equal(head(COMMIT_PUSHED), moved.remote);
});

test("a claim keeps the saved head for a pipeline_commit push after the review", () => {
  const { saved, remote } = movedBranch(COMMIT_PUSHED_LATE);
  recordPush(COMMIT_PUSHED_LATE, remote, "pipeline-commit");
  const kept = claimSaved(COMMIT_PUSHED_LATE, saved);
  assert.deepEqual(kept.state, { ...saved, lease: LEASE });
  assert.equal(head(COMMIT_PUSHED_LATE), saved.headSha);
});
