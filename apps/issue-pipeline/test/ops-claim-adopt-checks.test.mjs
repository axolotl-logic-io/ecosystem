// A claim of an issue saved at checks whose branch a stage job pushed past
// the saved head (#447): a CI fixer's pipeline_commit push, or a job's exit
// push, whose state save never happened, as when the CI fixer of #416 failed
// on a provider's rate limit after it committed. The claim adopts the head
// and sends it back to review, so it is never passed unreviewed; any other
// head, or no record, still leaves the saved state and the remote head the
// sweep stops on with branch-changed.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADOPTED_LOG,
  CLAIM_IDS,
  claimSaved,
  head,
  LOGGED,
  movedBranch,
  recordPush,
  SHORT_SHA,
} from "./ops-claim-adopt-test-kit.mjs";
import { claimReply, LEASE } from "./ops-claim-test-kit.mjs";

// The issues: a job's exit push and a pipeline_commit push adopted at checks,
// then a record of each op that names another head.
const EXIT_PUSHED_LATE = 67;
const COMMIT_PUSHED_LATE = 69;
const EXIT_OTHER_HEAD = 70;
const COMMIT_OTHER_HEAD = 71;
// The CI fixes the saved state had already made, which adoption keeps.
const CI_FIXES = 1;

// Issue `n` saved at checks after a CI fix and its check-fix review, with
// findings on record, and its branch one commit past the saved head.
/** @param {number} n */
function savedAfterCiFix(n) {
  const { saved, remote } = movedBranch(n);
  const at = {
    ...saved,
    reviewedSha: saved.headSha,
    ciFixes: CI_FIXES,
    testsOnly: true,
    round: 1,
    findings: [{ id: "f1", status: "resolved" }],
  };
  return { saved: at, remote };
}

// Claims `n`, saved as savedAfterCiFix saves it, with a push by `op` of the
// branch's head recorded, or of the saved head when `recorded` is "saved".
// Returns the claim's reply, the saved state, the branch's head, the claim's
// log and the worktree's head after the claim.
/** @param {number} n @param {string} op @param {"branch" | "saved"} [recorded] */
function claimAtChecks(n, op, recorded = "branch") {
  const { saved, remote } = savedAfterCiFix(n);
  let sha = remote;
  if (recorded === "saved") {
    sha = saved.headSha;
  }
  recordPush(n, sha, op);
  const got = claimSaved(n, saved);
  const { log } = LOGGED.parse(got.state);
  return { got, saved, remote, log, worktreeHead: head(n) };
}

// The reply of a claim of `n` that adopted `remote` from `saved` at checks:
// back to review on that head with nothing passed, the rest of the saved
// state kept, and `log` its log.
/** @param {number} n @param {object} saved @param {string} remote @param {string[]} log @returns {object} */
function adoptedReply(n, saved, remote, log) {
  const state = {
    ...saved,
    stage: "review",
    headSha: remote,
    passedSha: null,
    testsOnly: false,
    log,
    lease: LEASE,
  };
  const claim = { id: n * CLAIM_IDS, posted: false };
  return claimReply(n, { state, claim, remoteHead: remote });
}

// A stage job pushes, as it exits, the commits its checkout holds past its
// last state save (#315); from checks the head goes back to review.
test("a claim adopts a job's exit push at checks and sends it back to review", () => {
  const { got, saved, remote, log, worktreeHead } = claimAtChecks(
    EXIT_PUSHED_LATE,
    "exit-push",
  );
  assert.equal(log.length, 1);
  assert.match(log.join(""), ADOPTED_LOG);
  assert.ok(log.join("").includes(remote.slice(0, SHORT_SHA)));
  assert.deepEqual(got, adoptedReply(EXIT_PUSHED_LATE, saved, remote, log));
  assert.equal(worktreeHead, remote);
});

// A CI fixer's commits are pushed as it makes them (#303); if its stage ends
// before the save, the claim adopts them and they are reviewed before checks.
test("a claim adopts a pipeline_commit push at checks and sends it back to review", () => {
  const { got, saved, remote, log, worktreeHead } = claimAtChecks(
    COMMIT_PUSHED_LATE,
    "pipeline-commit",
  );
  assert.equal(log.length, 1);
  assert.match(log.join(""), ADOPTED_LOG);
  assert.ok(log.join("").includes(remote.slice(0, SHORT_SHA)));
  assert.deepEqual(got, adoptedReply(COMMIT_PUSHED_LATE, saved, remote, log));
  assert.equal(worktreeHead, remote);
});

// A record that names the saved head rather than the branch's: the claim
// keeps the saved state and reports the branch's head, the facts the sweep's
// branch-changed stop is built on.
test("a claim at checks keeps the saved head when an exit push record names another", () => {
  const { got, saved, remote, worktreeHead } = claimAtChecks(
    EXIT_OTHER_HEAD,
    "exit-push",
    "saved",
  );
  assert.deepEqual(got.state, { ...saved, lease: LEASE });
  assert.equal(got.remoteHead, remote);
  assert.equal(worktreeHead, saved.headSha);
});

test("a claim at checks keeps the saved head when a pipeline_commit record names another", () => {
  const { got, saved, remote, worktreeHead } = claimAtChecks(
    COMMIT_OTHER_HEAD,
    "pipeline-commit",
    "saved",
  );
  assert.deepEqual(got.state, { ...saved, lease: LEASE });
  assert.equal(got.remoteHead, remote);
  assert.equal(worktreeHead, saved.headSha);
});
