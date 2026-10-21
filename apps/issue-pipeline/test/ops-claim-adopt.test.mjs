// @ts-check
// A claim that carries on from a saved state whose head the branch on GitHub
// no longer has: it adopts the head only when this machine recorded pushing
// it, as after a push whose state save failed, and otherwise keeps the saved
// state and reports the branch's head. An adopted head is never passed
// unreviewed: implement keeps its stage, whose review follows, and a review
// goes back to review with its verdict and verification voided (a merge's
// return is in ops-claim-provenance.test.mjs). Version 2 adopts every
// pipeline push this way, whichever op made it, so the old per-stage and
// per-op cases (open-pr, checks, a CI fix's push, #447) are these. The old
// sweep-level follow-through (ops-claim-adopt-review.test.mjs, on the removed
// workflow harness) is this file's voided verdict plus the orchestrator,
// which runs the review stage a state at review names; a job that pushed and
// then hit a rate limit (#416) leaves the push record this file adopts.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ADOPTED_LOG,
  CLAIM_IDS,
  claimSaved,
  head,
  heldComments,
  LOGGED,
  movedBranch,
  recordPush,
  SHORT_SHA,
} from "./ops-claim-adopt-test-kit.mjs";
import { claimedFields, claimReply } from "./ops-claim-test-kit.mjs";
import { runDir } from "./ops-cli-test-kit.mjs";

// The issues: one with a matching push record, one whose record names another
// head, one with no record and then an unreadable one, one adopted at review,
// and one whose record is a pipeline_commit push from implement.
const ADOPTED = 61;
const OTHER_RECORD = 62;
const NO_RECORD = 63;
const AT_REVIEW = 64;
const COMMIT_PUSHED = 68;
// The review round and conflict fixes the saved state had, which adoption
// keeps.
const ROUND = 2;
const CONFLICT_FIXES = 1;

test("a claim adopts the head this machine recorded pushing, keeping implement", () => {
  const { saved, remote } = movedBranch(ADOPTED);
  recordPush(ADOPTED, remote);
  const got = claimSaved(ADOPTED, saved);
  const { log } = LOGGED.parse(got.state);
  assert.equal(log.length, 1);
  assert.match(log.join(""), ADOPTED_LOG);
  assert.ok(log.join("").includes(remote.slice(0, SHORT_SHA)));
  const state = { ...saved, headSha: remote, log, ...claimedFields(ADOPTED) };
  const claim = { id: ADOPTED * CLAIM_IDS, posted: false };
  const comments = heldComments(ADOPTED, saved);
  const remoteHead = remote;
  const want = claimReply(ADOPTED, { state, claim, remoteHead, comments });
  assert.deepEqual(got, want);
  assert.equal(head(ADOPTED), remote);
});

test("a claim keeps the saved head when the record names another, reporting the branch's", () => {
  const { saved, remote } = movedBranch(OTHER_RECORD);
  recordPush(OTHER_RECORD, saved.headSha);
  const kept = claimSaved(OTHER_RECORD, saved);
  assert.deepEqual(kept.state, { ...saved, ...claimedFields(OTHER_RECORD) });
  assert.equal(kept.remoteHead, remote);
  assert.deepEqual(kept.branchChanged, { saved: saved.headSha, remote });
  assert.equal(head(OTHER_RECORD), saved.headSha);
});

test("a claim keeps the saved head with no record or an unreadable one", () => {
  const { saved, remote } = movedBranch(NO_RECORD);
  const missing = claimSaved(NO_RECORD, saved);
  assert.deepEqual(missing.state, { ...saved, ...claimedFields(NO_RECORD) });
  assert.deepEqual(missing.branchChanged, { saved: saved.headSha, remote });
  fs.mkdirSync(runDir(NO_RECORD), { recursive: true });
  fs.writeFileSync(path.join(runDir(NO_RECORD), "pushed.json"), "{not json");
  const malformed = claimSaved(NO_RECORD, saved);
  assert.deepEqual(malformed.state, { ...saved, ...claimedFields(NO_RECORD) });
  assert.deepEqual(malformed.branchChanged, { saved: saved.headSha, remote });
  assert.equal(head(NO_RECORD), saved.headSha);
});

test("a claim adopts a push at review with its verdict and verification voided, keeping the rest", () => {
  const moved = movedBranch(AT_REVIEW);
  const review = {
    round: ROUND,
    verdict: /** @type {const} */ ("changes"),
    commentId: null,
    findings: [],
    revision: { code: moved.saved.headSha, inputs: "x" },
  };
  const saved = {
    ...moved.saved,
    stage: /** @type {const} */ ("review"),
    verifiedSha: moved.saved.headSha,
    review,
    counts: { conflictFixes: CONFLICT_FIXES, syncs: 0 },
  };
  recordPush(AT_REVIEW, moved.remote, "pipeline-commit");
  const got = claimSaved(AT_REVIEW, saved);
  const { log } = LOGGED.parse(got.state);
  assert.match(log.join(""), ADOPTED_LOG);
  const state = {
    ...saved,
    headSha: moved.remote,
    verifiedSha: null,
    review: { ...review, verdict: null },
    log,
    ...claimedFields(AT_REVIEW),
  };
  assert.deepEqual(got.state, state);
  assert.equal(got.branchChanged, undefined);
  assert.equal(head(AT_REVIEW), moved.remote);
});

// pipeline_commit pushes an interrupted implementer's commits as it makes
// them (#303): the claim adopts them where it adopts any pipeline push.
test("a claim adopts a pipeline_commit push at implement, keeping the stage", () => {
  const moved = movedBranch(COMMIT_PUSHED);
  recordPush(COMMIT_PUSHED, moved.remote, "pipeline-commit");
  const got = claimSaved(COMMIT_PUSHED, moved.saved);
  const { log } = LOGGED.parse(got.state);
  assert.match(log.join(""), ADOPTED_LOG);
  const state = {
    ...moved.saved,
    headSha: moved.remote,
    log,
    ...claimedFields(COMMIT_PUSHED),
  };
  assert.deepEqual(got.state, state);
  assert.equal(head(COMMIT_PUSHED), moved.remote);
});
