// @ts-check
// The finalizer rebases and retests before merging (#422), against local git
// and the fake gh: a branch behind its base is rebased, pushed and retested
// in the one merge job, then merged at the rebased head; a conflicting
// rebase is aborted and goes to sync with the passed head kept; a failing
// retest goes to checks; pending CI ends held, and the next job only waits
// on CI; a branch already on its base's head merges with no rebase.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchHead,
  containsBase,
  fx,
  mergedAt,
  minutesOf,
  opsSent,
  placeOf,
  runJob,
  sentTo,
} from "./finalizer-rebase-test-kit.mjs";

const DONE = { kind: "saved", stage: "done" };
// The repo config's maxSyncs (role-context-fixtures.mjs).
const MAX_SYNCS = 3;
// verify's minutes, and the CI wait's: the config's 30 and 10 more.
const VERIFY_MINUTES = 120;
const CI_MINUTES = 40;
const REBASE_COMMENT = /Rebased onto integration without conflicts/u;
const CONFLICT_DEFERRED = /merge deferred: conflict; rebasing now/u;

test("at merge on a branch behind its base, the one job rebases, pushes, retests and merges", async () => {
  const place = placeOf({ issue: 61, base: "behind" });
  const end = await runJob(place);
  assert.deepEqual(end, DONE);
  assert.deepEqual(opsSent(place), [
    "merge",
    "sync-base",
    "verify",
    "ci-status",
    "merge",
  ]);
  const rebased = branchHead(place);
  assert.notEqual(rebased, place.verified);
  assert.ok(containsBase(place));
  const [{ testsOnly: retestOnly, comments } = {}] = sentTo(place, "verify");
  assert.equal(retestOnly, true);
  assert.match(JSON.stringify(comments), REBASE_COMMENT);
  const [, { expectedSha } = {}] = sentTo(place, "merge");
  assert.equal(expectedSha, rebased);
  assert.deepEqual(mergedAt(place), [rebased]);
  assert.deepEqual(minutesOf(place, "verify"), [VERIFY_MINUTES]);
  assert.deepEqual(minutesOf(place, "ci-status"), [CI_MINUTES]);
  const { stage, syncs, verifiedSha, testsOnly } = place.saved;
  assert.equal(stage, "done");
  assert.equal(syncs, 1);
  assert.equal(verifiedSha, rebased);
  assert.equal(testsOnly, false);
});

test("a conflicting rebase is aborted and saves at sync, the passed head kept", async () => {
  const place = placeOf({ issue: 62, base: "conflict" });
  const end = await runJob(place);
  assert.deepEqual(end, { kind: "saved", stage: "sync" });
  assert.deepEqual(opsSent(place), ["merge", "sync-base"]);
  const [{ keepConflict } = {}] = sentTo(place, "sync-base");
  assert.equal(keepConflict, false);
  assert.equal(fx.inRebase(place.issue), false);
  assert.equal(fx.worktreeState(place.issue).head, place.verified);
  assert.equal(branchHead(place), place.verified);
  assert.deepEqual(mergedAt(place), []);
  const { stage, passedSha, testsOnly } = place.saved;
  assert.equal(stage, "sync");
  assert.equal(passedSha, place.verified);
  assert.equal(testsOnly, false);
});

test("a merge GitHub finds conflicting is rebased too, and its conflict saves at sync", async () => {
  const place = placeOf({
    issue: 69,
    base: "conflict",
    mergeable: "CONFLICTING",
  });
  const end = await runJob(place);
  assert.deepEqual(end, { kind: "saved", stage: "sync" });
  assert.deepEqual(opsSent(place), ["merge", "sync-base"]);
  const { passedSha, log } = place.saved;
  assert.equal(passedSha, place.verified);
  assert.match(String(log), CONFLICT_DEFERRED);
});

test("a failing retest saves at checks with testsOnly cleared", async () => {
  const place = placeOf({ issue: 63, base: "behind", test: "false" });
  const end = await runJob(place);
  assert.deepEqual(end, { kind: "saved", stage: "checks" });
  assert.deepEqual(opsSent(place), ["merge", "sync-base", "verify"]);
  const { stage, testsOnly, headSha, verifiedSha } = place.saved;
  assert.equal(stage, "checks");
  assert.equal(testsOnly, false);
  assert.equal(headSha, branchHead(place));
  assert.equal(verifiedSha, place.verified);
  assert.deepEqual(mergedAt(place), []);
});

test("failing CI after the retest saves at checks with testsOnly cleared", async () => {
  const place = placeOf({ issue: 64, base: "behind" });
  const end = await runJob(place, { ci: ["fail"] });
  assert.deepEqual(end, { kind: "saved", stage: "checks" });
  const { stage, testsOnly, verifiedSha } = place.saved;
  assert.equal(stage, "checks");
  assert.equal(testsOnly, false);
  assert.equal(verifiedSha, branchHead(place));
  assert.deepEqual(mergedAt(place), []);
});

test("pending CI ends held at merge, and the next job merges without rebasing again", async () => {
  const place = placeOf({ issue: 65, base: "behind" });
  const first = await runJob(place, { ci: ["pending"] });
  assert.deepEqual(first, { kind: "held" });
  const rebased = branchHead(place);
  const { stage, verifiedSha, testsOnly } = place.saved;
  assert.equal(stage, "merge");
  assert.equal(verifiedSha, rebased);
  assert.equal(testsOnly, true);
  assert.deepEqual(mergedAt(place), []);
  place.sent = [];
  const next = await runJob(place);
  assert.deepEqual(next, DONE);
  assert.deepEqual(opsSent(place), ["ci-status", "merge"]);
  assert.deepEqual(mergedAt(place), [rebased]);
  const { syncs } = place.saved;
  assert.equal(syncs, 1);
});

test("a branch that already contains its target's head merges with no rebase", async () => {
  const place = placeOf({ issue: 66, base: "current" });
  const end = await runJob(place);
  assert.deepEqual(end, DONE);
  assert.deepEqual(opsSent(place), ["merge"]);
  assert.deepEqual(mergedAt(place), [place.verified]);
});

test("a job killed after the rebase's push goes on to retest and merge in the next job, counting one rebase", async () => {
  const place = placeOf({ issue: 67, base: "behind" });
  const first = await runJob(place, { killAfter: "sync-base" });
  assert.equal(first, "killed");
  const rebased = branchHead(place);
  place.sent = [];
  const next = await runJob(place);
  assert.deepEqual(next, DONE);
  assert.deepEqual(opsSent(place), [
    "sync-base",
    "verify",
    "ci-status",
    "merge",
  ]);
  assert.equal(branchHead(place), rebased);
  assert.deepEqual(mergedAt(place), [rebased]);
  const { syncs } = place.saved;
  assert.equal(syncs, 1);
});

test("a rebase past maxSyncs stops the issue as sync-limit, unmerged", async () => {
  const start = { syncs: MAX_SYNCS };
  const place = placeOf({ issue: 68, base: "behind", start });
  const end = await runJob(place);
  assert.deepEqual(end, { kind: "stopped", code: "sync-limit" });
  assert.deepEqual(opsSent(place), ["merge", "sync-base", "stop"]);
  assert.deepEqual(mergedAt(place), []);
});
