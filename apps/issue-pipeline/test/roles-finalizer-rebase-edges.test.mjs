// @ts-check
// The finalizer's rebase and retest at their edges (#422), against local git
// and the fake gh: a rebase that leaves no code change goes to sync; a clean
// rebase that leaves the head where it was goes straight to the retested
// merge; a merge behind again after the retest ends held and the next job
// rebases again, counted; pending CI is noted once while it lasts; and a
// network error during the rebase holds, and the next job resumes at it.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  branchHead,
  containsBase,
  mergedAt,
  opsSent,
  placeOf,
  runJob,
} from "./finalizer-rebase-test-kit.mjs";

const DONE = { kind: "saved", stage: "done" };
const HELD = { kind: "held" };
const RETEST = ["sync-base", "verify", "ci-status", "merge"];
const NO_CODE_LEFT = /rebased onto integration; no code change is left/u;
const CONFLICT_AGAIN =
  /merge deferred: conflict again after the rebase; will rebase next job/u;
const BEHIND_AGAIN =
  /merge deferred: behind again after the rebase; will rebase next job/u;
const CI_PENDING = "CI still running after the rebase; will check next job";
const NETWORK_ERROR = "Could not resolve host: github.com";
const NETWORK_DEFERRED = /deferred: network error during sync-base/u;

/** @param {readonly unknown[] | null | undefined} log @param {string} text @returns {number} */
function linesWith(log, text) {
  return (log ?? []).filter((line) => String(line).includes(text)).length;
}

test("a rebase that leaves no code change is counted and saves at sync, unmerged", async () => {
  const place = placeOf({ issue: 71, base: "same" });
  const end = await runJob(place);
  assert.deepEqual(end, { kind: "saved", stage: "sync" });
  assert.deepEqual(opsSent(place), ["merge", "sync-base"]);
  assert.deepEqual(mergedAt(place), []);
  const { stage, syncs, passedSha, testsOnly, log } = place.saved;
  assert.equal(stage, "sync");
  assert.equal(syncs, 1);
  assert.equal(passedSha, place.verified);
  assert.equal(testsOnly, false);
  assert.match(String(log), NO_CODE_LEFT);
});

test("a clean rebase that leaves the head where it was goes straight to the retested merge, uncounted", async () => {
  const place = placeOf({
    issue: 72,
    base: "current",
    mergeable: "CONFLICTING",
  });
  const end = await runJob(place);
  assert.deepEqual(end, HELD);
  assert.deepEqual(opsSent(place), ["merge", "sync-base", "merge"]);
  assert.equal(branchHead(place), place.verified);
  assert.deepEqual(mergedAt(place), []);
  const { stage, syncs, log } = place.saved;
  assert.equal(stage, "merge");
  assert.equal(syncs, 0);
  assert.match(String(log), CONFLICT_AGAIN);
});

test("a merge behind again after the retest ends held, and the next job rebases again, counted", async () => {
  const place = placeOf({ issue: 73, base: "behind" });
  const first = await runJob(place, { moveBaseAfter: "ci-status" });
  assert.deepEqual(first, HELD);
  assert.deepEqual(opsSent(place), ["merge", ...RETEST]);
  assert.deepEqual(mergedAt(place), []);
  const { stage, syncs, log } = place.saved;
  assert.equal(stage, "merge");
  assert.equal(syncs, 1);
  assert.match(String(log), BEHIND_AGAIN);
  place.sent = [];
  const next = await runJob(place);
  assert.deepEqual(next, DONE);
  assert.deepEqual(opsSent(place), ["merge", ...RETEST]);
  assert.ok(containsBase(place));
  assert.deepEqual(mergedAt(place), [branchHead(place)]);
  const { syncs: rebases } = place.saved;
  assert.equal(rebases, 2);
});

test("pending CI after the rebase is noted once while it lasts", async () => {
  const place = placeOf({ issue: 74, base: "behind" });
  assert.deepEqual(await runJob(place, { ci: ["pending"] }), HELD);
  place.sent = [];
  assert.deepEqual(await runJob(place, { ci: ["pending"] }), HELD);
  assert.deepEqual(opsSent(place), ["ci-status"]);
  assert.equal(linesWith(place.saved.log, CI_PENDING), 1);
  place.sent = [];
  assert.deepEqual(await runJob(place), DONE);
  assert.deepEqual(opsSent(place), ["ci-status", "merge"]);
  assert.equal(linesWith(place.saved.log, CI_PENDING), 1);
});

test("a network error during the rebase holds, and the next job resumes at the rebase, counting it once", async () => {
  const place = placeOf({ issue: 75, base: "behind" });
  const failOnce = { op: "sync-base", error: NETWORK_ERROR };
  const first = await runJob(place, { failOnce });
  assert.deepEqual(first, HELD);
  assert.deepEqual(opsSent(place), ["merge", "sync-base"]);
  assert.equal(branchHead(place), place.verified);
  assert.match(String(place.saved.log), NETWORK_DEFERRED);
  const { checkpoints } = place.saved;
  const { rebaseOf } = checkpoints ?? {};
  assert.equal(rebaseOf, place.verified);
  place.sent = [];
  const next = await runJob(place);
  assert.deepEqual(next, DONE);
  assert.deepEqual(opsSent(place), RETEST);
  assert.ok(containsBase(place));
  assert.deepEqual(mergedAt(place), [branchHead(place)]);
  const { syncs } = place.saved;
  assert.equal(syncs, 1);
});
