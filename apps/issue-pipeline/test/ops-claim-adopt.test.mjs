// A claim that carries on from a saved state whose head the branch on GitHub
// no longer has: it adopts the head only when this machine recorded pushing
// it, as after a push whose state save failed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
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
// review, and one whose record is a CI fix's push.
const ADOPTED = 61;
const OTHER_RECORD = 62;
const NO_RECORD = 63;
const BEFORE_REVIEW = 64;
const CI_FIX = 65;
// Each issue's claim comment id; its state comment follows it.
const CLAIM_IDS = 10;

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Issue `n`, saved at checks with its worktree on the base, and a branch on
// GitHub one commit past the saved head. Returns the saved state and the
// branch's head.
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
function recordPush(n, sha, op = "finish-sync") {
  fs.mkdirSync(runDir(n), { recursive: true });
  const record = JSON.stringify({ sha, op, at: TIME });
  fs.writeFileSync(path.join(runDir(n), "pushed.json"), record);
}

// Claims `n`, which this lane already holds, from the saved state `saved`.
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
  return askOps({ op: "claim", number: n, ...LANE });
}

function head(n) {
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

test("a claim adopts the head this machine recorded pushing", () => {
  const { saved, remote } = movedBranch(ADOPTED);
  recordPush(ADOPTED, remote);
  const line = `${TIME} adopted the pipeline's own push ${remote.slice(0, SHORT_SHA)}; its state save had failed`;
  const state = {
    ...saved,
    headSha: remote,
    passedSha: null,
    stage: "sync",
    log: [line],
    lease: LEASE,
  };
  const claim = { id: ADOPTED * CLAIM_IDS, posted: false };
  const want = claimReply(ADOPTED, { state, claim, remoteHead: remote });
  assert.deepEqual(claimSaved(ADOPTED, saved), want);
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
