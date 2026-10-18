// @ts-check
// State version 2: a legacy (version 1) state migrates to the author, keeping
// its PR, head, lease and flows, and an approval holds only for the exact
// revision the reviewer saw (`approval-is-for-one-revision`).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalHolds,
  newIssueState,
  parseIssueState,
  resumeOf,
} from "../src/state.ts";

const LEASE = {
  lane: "orchestrator",
  sweepId: "s1",
  at: "2026-10-18T12:00:00Z",
};

// The field sets the installed version saves at a late stage, with the spec
// writer's fields that the migration drops.
const LEGACY_REVIEW = {
  version: 1,
  number: 475,
  stage: "review",
  lease: LEASE,
  pr: 477,
  headSha: "abc123",
  flows: { code: true, wiki: true },
  specWritesTests: true,
  specTestsSha: "def456",
  spec: "## Spec",
  interfaces: [],
  findings: [{ status: "open" }],
  log: ["2026-10-18T12:00Z claimed"],
};

test("a legacy state past the spec goes to the author, then implement", () => {
  for (const stage of ["implement", "review", "checks", "accept", "merge"]) {
    const state = parseIssueState({ ...LEGACY_REVIEW, stage }, 475);
    assert.ok(state !== null);
    assert.equal(state.version, 2);
    assert.equal(state.stage, "author");
    assert.equal(state.resumeStage, "implement");
    assert.equal(state.pr, 477);
    assert.equal(state.headSha, "abc123");
    assert.deepEqual(state.lease, LEASE);
    assert.deepEqual(state.flows, { code: true, wiki: true });
    assert.equal(state.verifiedSha, null);
    assert.equal(state.review.revision, null);
    assert.equal("specWritesTests" in state, false);
  }
});

test("triage, spec and no stage go to the author alone", () => {
  for (const stage of ["triage", "spec", undefined]) {
    const state = parseIssueState({ version: 1, stage }, 9);
    assert.equal(state?.stage, "author");
    assert.equal(state?.resumeStage, null);
  }
});

test("stopped, done and publish keep their meaning", () => {
  const stopped = parseIssueState(
    { stage: "stopped", stoppedStage: "fix", stopCode: "conflict" },
    3,
  );
  assert.equal(stopped?.stage, "stopped");
  assert.equal(stopped?.stoppedStage, "author");
  assert.equal(stopped?.resumeStage, "implement");
  assert.equal(stopped?.stopCode, "conflict");
  assert.equal(parseIssueState({ stage: "done" }, 3)?.stage, "done");
  const publish = parseIssueState({ stage: "publish", pr: 4 }, 3);
  assert.equal(publish?.stage, "author");
  assert.equal(publish?.resumeStage, "review");
});

test("a version 2 state reads back as saved, and a bad field as its default", () => {
  const saved = { ...newIssueState(5), stage: "review", pr: 8 };
  assert.deepEqual(parseIssueState(saved, 5), saved);
  const bad = parseIssueState({ ...saved, pr: "eight", counts: null }, 5);
  assert.equal(bad?.pr, null);
  assert.deepEqual(bad?.counts, { conflictFixes: 0, syncs: 0 });
  assert.equal(parseIssueState({ ...saved, stage: "fix" }, 5), null);
});

test("lifting a stop resumes the stage that stopped with its counts reset", () => {
  const stopped = {
    ...newIssueState(5),
    stage: /** @type {const} */ ("stopped"),
    stoppedStage: /** @type {const} */ ("implement"),
    stopCode: "conflict",
    counts: { conflictFixes: 2, syncs: 3 },
  };
  const lifted = resumeOf(stopped);
  assert.equal(lifted.stage, "implement");
  assert.equal(lifted.stopCode, null);
  assert.deepEqual(lifted.counts, { conflictFixes: 0, syncs: 0 });
});

test("an approval holds only for the code, wiki and inputs revision reviewed", () => {
  const revision = { code: "c1", wiki: "w1", inputs: "i1" };
  const state = newIssueState(5);
  const approved = {
    ...state,
    review: {
      ...state.review,
      verdict: /** @type {const} */ ("approve"),
      revision,
    },
  };
  assert.equal(approvalHolds(approved, revision), true);
  assert.equal(approvalHolds(approved, { ...revision, code: "c2" }), false);
  assert.equal(approvalHolds(approved, { ...revision, wiki: "w2" }), false);
  assert.equal(approvalHolds(approved, { ...revision, inputs: "i2" }), false);
  const changes = {
    ...approved,
    review: { ...approved.review, verdict: /** @type {const} */ ("changes") },
  };
  assert.equal(approvalHolds(changes, revision), false);
});
