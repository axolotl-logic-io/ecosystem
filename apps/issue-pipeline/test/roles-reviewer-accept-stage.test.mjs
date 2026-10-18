// @ts-check
// The reviewer role at `--stage accept` (#423), from a state today's checks
// saved: an unchanged patch id keeps the verdict with no session, a pass
// saves at security recording the head and patch id it judged, a fail
// saves at fix with an open acceptance finding, a branch moved since
// verification stops before the session, a network failure defers, and a
// failed prep or an unreadable verdict stops.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { piStarts, USAGE } from "./job-test-kit.mjs";
import {
  acceptJob,
  modelsOf,
  NEXT_FINDING_ID,
  PATCH_ID,
  PR,
  VERIFIED,
} from "./reviewer-job-test-kit.mjs";

const PASSED = "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff";
const KEPT_TEXT = "acceptance kept: changes unchanged since c0ffeec0ffee";
const PASS = { verdict: "pass", reason: "It does what #7 asks." };
const FAIL = { verdict: "fail", reason: "The wiki misses the new stage." };
const SONNET = /sonnet/u;
const NO_MERGE_BASE = /no merge base/u;

/** @param {object} verdict @returns {Record<string, readonly object[]>} a verifier that replies `verdict` */
function verifierReplying(verdict) {
  return { accept: [messageEnd(USAGE), outputEnd(verdict)] };
}

const kept = acceptJob(verifierReplying(PASS), {
  acceptedSha: PASSED,
  acceptedPatchId: PATCH_ID,
});
const passed = acceptJob(verifierReplying(PASS), {
  acceptedSha: PASSED,
  acceptedPatchId: "0".repeat(PASSED.length),
});
const failed = acceptJob(verifierReplying(FAIL), {
  acceptedSha: PASSED,
  acceptedPatchId: "0".repeat(PASSED.length),
});
const moved = acceptJob(verifierReplying(PASS), {}, { headSha: PASSED });
const offline = acceptJob(
  verifierReplying(PASS),
  {},
  { ok: false, error: "gh: Could not resolve host: api.github.com" },
);
const unprepared = acceptJob(
  verifierReplying(PASS),
  {},
  { ok: false, error: "no merge base" },
);
const unreadable = acceptJob(verifierReplying({}), {
  acceptedSha: PASSED,
  acceptedPatchId: "0".repeat(PASSED.length),
});

test("an unchanged patch id saves at security with no session, logging and commenting the kept verdict", () => {
  assert.equal(kept.r.status, 0, kept.r.stderr);
  assert.deepEqual(kept.summary, {
    issue: 7,
    stage: "accept",
    end: { kind: "saved", stage: "security" },
  });
  assert.deepEqual(piStarts(kept.place), []);
  const { saved } = kept;
  assert.equal(saved.stage, "security");
  assert.equal(saved.acceptedSha, PASSED);
  assert.equal(saved.acceptedPatchId, PATCH_ID);
  assert.ok(
    saved.log.some((/** @type {string} */ line) => line.includes(KEPT_TEXT)),
  );
  const [comment] = kept.comments;
  assert.equal(kept.comments.length, 1);
  assert.equal(comment?.number, PR);
  assert.ok(comment?.body.includes(KEPT_TEXT), "comments the kept verdict");
});

test("a pass saves at security, recording the verified head and its patch id", () => {
  assert.equal(passed.r.status, 0, passed.r.stderr);
  assert.deepEqual(passed.summary.end, { kind: "saved", stage: "security" });
  const { accept: verifierModel = "" } = modelsOf(passed.place);
  assert.match(verifierModel, SONNET);
  const { saved } = passed;
  assert.equal(saved.stage, "security");
  assert.equal(saved.acceptedSha, VERIFIED);
  assert.equal(saved.acceptedPatchId, PATCH_ID);
  assert.equal(saved.acceptReason, PASS.reason);
  const verdict = passed.comments.find(
    ({ by }) => by.role === "acceptance verifier",
  );
  assert.ok(verdict?.body.includes(PASS.reason), "posts the verdict");
  assert.equal(verdict?.number, PR);
});

test("a fail saves at fix with an open acceptance finding, clearing the accepted head and patch id", () => {
  assert.equal(failed.r.status, 0, failed.r.stderr);
  assert.deepEqual(failed.summary.end, { kind: "saved", stage: "fix" });
  const { saved } = failed;
  assert.equal(saved.stage, "fix");
  assert.equal(saved.acceptedSha, null);
  assert.equal(saved.acceptedPatchId, null);
  assert.equal(saved.reviewedSha, VERIFIED);
  assert.equal(saved.nextFindingId, NEXT_FINDING_ID + 1);
  assert.deepEqual(
    saved.findings.map(
      (
        /** @type {{ id: string, status: string, lenses: string[], evidence: string }} */ f,
      ) => ({
        id: f.id,
        status: f.status,
        lenses: f.lenses,
        evidence: f.evidence,
      }),
    ),
    [
      {
        id: `f${NEXT_FINDING_ID + 1}`,
        status: "open",
        lenses: ["acceptance"],
        evidence: FAIL.reason,
      },
    ],
  );
  const verdict = failed.comments.find(
    ({ by }) => by.role === "acceptance verifier",
  );
  assert.ok(verdict?.body.includes(FAIL.reason), "posts the verdict");
});

test("a branch moved since verification stops before the session", () => {
  assert.equal(moved.r.status, 0, moved.r.stderr);
  assert.deepEqual(moved.summary.end, { kind: "stopped", code: "error" });
  assert.deepEqual(piStarts(moved.place), []);
  assert.equal(moved.stops.length, 1);
  assert.equal(moved.stops[0].reason, "the branch changed after verification");
});

test("a network failure preparing the diff defers, leaving the issue at accept", () => {
  assert.equal(offline.r.status, 0, offline.r.stderr);
  assert.deepEqual(offline.summary.end, { kind: "held" });
  assert.deepEqual(piStarts(offline.place), []);
  assert.deepEqual(offline.stops, []);
  assert.equal(offline.saved?.stage, "accept");
});

test("any other failure preparing the diff stops before the session, with the op's error", () => {
  assert.equal(unprepared.r.status, 0, unprepared.r.stderr);
  assert.deepEqual(unprepared.summary.end, { kind: "stopped", code: "error" });
  assert.deepEqual(piStarts(unprepared.place), []);
  assert.equal(unprepared.stops.length, 1);
  assert.equal(unprepared.stops[0].reason, "could not prepare the final diff");
  assert.match(String(unprepared.stops[0].detail), NO_MERGE_BASE);
});

test("a verdict that doesn't fit its schema stops, posting no verdict", () => {
  assert.equal(unreadable.r.status, 0, unreadable.r.stderr);
  assert.deepEqual(unreadable.summary.end, { kind: "stopped", code: "error" });
  assert.equal(piStarts(unreadable.place).length, 1, "the verifier ran");
  assert.equal(unreadable.stops.length, 1);
  assert.equal(unreadable.stops[0].reason, "the acceptance verifier failed");
  assert.deepEqual(
    unreadable.comments.filter(({ by }) => by.role === "acceptance verifier"),
    [],
  );
});
