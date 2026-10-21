// @ts-check
// The orchestrator's scheduler on completions (`completion-reconciliation`):
// an open issue saved done with its merged revision, which finish-wiki hasn't
// closed, runs a merge job that only finishes it, with agent:merged or an open
// prerequisite and never via a re-author, while stop labels, skip labels,
// untrusted authors, live jobs, leases and legacy jobs still apply and a
// plain done gets no decision.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decided,
  jobAt,
  NOW,
  scheduled,
  snapshotOf,
} from "./orchestrator-fixtures.mjs";

// An open issue the after mark names.
const PREREQ = 9;
const SHA_LENGTH = 40;
// What a completed issue's merge role saved as merged.
const MERGED = { code: "c".repeat(SHA_LENGTH), inputs: "inputs-1" };
const COMPLETED = /** @type {const} */ ({
  stage: "done",
  pr: 40,
  state: { merged: MERGED },
});

test("an open done issue with its merged revision starts a merge job, with agent:merged or an open prerequisite", () => {
  const completions = [
    { number: 1, ...COMPLETED },
    { number: 1, ...COMPLETED, labels: ["agent:merged"] },
    { number: 1, ...COMPLETED, after: [PREREQ] },
  ];
  for (const completion of completions) {
    const [decision] = scheduled(snapshotOf([completion])).decisions;
    assert.equal(decision?.action, "started");
    assert.deepEqual(
      [decision.stage, decision.reason, decision.reauthor],
      ["merge", "free", null],
    );
  }
});

test("a completion is never sent back to the author by new trusted input; the merge role is", () => {
  const snapshot = snapshotOf([
    { number: 1, ...COMPLETED, gherkin: "inputs-0" },
  ]);
  assert.deepEqual(decided(snapshot), ["#1 merge started free"]);
});

test("a plain done issue, and a completion with a stop label, skip label, untrusted author or live job, get no decision", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "done" },
    { number: 2, stage: "done", labels: ["agent:merged"] },
    { number: 3, ...COMPLETED, labels: ["agent:stopped-error"] },
    { number: 4, ...COMPLETED, labels: ["wontfix"] },
    { number: 5, ...COMPLETED, authorAllowed: false },
    { number: 6, ...COMPLETED, job: jobAt("merge", "live") },
  ]);
  assert.deepEqual(decided(snapshot), []);
});

test("a completion is still held by another lane's live lease and by a live legacy job", () => {
  const lease = { lane: "sweep-a", sweepId: "x", at: NOW.toISOString() };
  const snapshot = snapshotOf([
    { number: 1, ...COMPLETED, state: { merged: MERGED, lease } },
    { number: 2, ...COMPLETED, legacyLive: true },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 merge held lease:sweep-a",
    "#2 merge held legacy-job-live",
  ]);
});
