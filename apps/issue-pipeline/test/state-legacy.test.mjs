// @ts-check
// State version 2: a legacy (version 1) state migrates to the author, keeping
// its PR, head, lease and flows, and a merge authorization holds only for
// the exact revision hardening saw (`approval-is-for-one-revision`).
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { approvalHolds, newIssueState, resumeOf } = await import(
  "../src/state.ts"
);
const { parseIssueState } = await import("../src/saved-state.ts");
const { LAUNCH, startedRecord } = await import("../src/job/launch-record.ts");

// The legacy issue, its PR and head; a short issue the stage tests use; and
// a version 2 issue with its PR.
const LEGACY_ISSUE = 475;
const LEGACY_PR = 477;
const LEGACY_HEAD = "abc123";
const SMALL_ISSUE = 3;
const OTHER_ISSUE = 9;
const PUBLISH_PR = 4;
const SAVED_ISSUE = 5;
const SAVED_PR = 8;
// Round counts a stop carried before it was lifted.
const CONFLICT_FIXES = 2;
const SYNCS = 3;
// The length of a SHA-1 commit id in hex.
const SHA1_HEX_LENGTH = 40;

const LEASE = {
  lane: "orchestrator",
  sweepId: "s1",
  at: "2026-10-18T12:00:00Z",
};

// The field sets the installed version saves at a late stage, with the spec
// writer's fields that the migration drops.
const LEGACY_REVIEW = {
  version: 1,
  number: LEGACY_ISSUE,
  stage: "review",
  lease: LEASE,
  pr: LEGACY_PR,
  headSha: LEGACY_HEAD,
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
    const state = parseIssueState({ ...LEGACY_REVIEW, stage }, LEGACY_ISSUE);
    assert.ok(state !== null);
    assert.equal(state.version, 2);
    assert.equal(state.stage, "author");
    assert.equal(state.resumeStage, "implement");
    assert.equal(state.pr, LEGACY_PR);
    assert.equal(state.headSha, LEGACY_HEAD);
    assert.deepEqual(state.lease, LEASE);
    assert.deepEqual(state.flows, { code: true, wiki: true });
    assert.equal(state.verifiedSha, null);
    assert.equal(state.review.revision, null);
    assert.equal("specWritesTests" in state, false);
  }
});

test("triage, spec and no stage go to the author alone", () => {
  for (const stage of ["triage", "spec", undefined]) {
    const state = parseIssueState({ version: 1, stage }, OTHER_ISSUE);
    assert.equal(state?.stage, "author");
    assert.equal(state?.resumeStage, null);
  }
});

test("stopped, done and publish keep their meaning", () => {
  const stopped = parseIssueState(
    { stage: "stopped", stoppedStage: "fix", stopCode: "conflict" },
    SMALL_ISSUE,
  );
  assert.equal(stopped?.stage, "stopped");
  assert.equal(stopped?.stoppedStage, "author");
  assert.equal(stopped?.resumeStage, "implement");
  assert.equal(stopped?.stopCode, "conflict");
  assert.equal(parseIssueState({ stage: "done" }, SMALL_ISSUE)?.stage, "done");
  const publish = parseIssueState(
    { stage: "publish", pr: PUBLISH_PR },
    SMALL_ISSUE,
  );
  assert.equal(publish?.stage, "author");
  assert.equal(publish?.resumeStage, "review");
});

test("a version 2 state reads back as saved, and a bad field as its default", () => {
  const saved = {
    ...newIssueState(SAVED_ISSUE),
    stage: "review",
    pr: SAVED_PR,
  };
  assert.deepEqual(parseIssueState(saved, SAVED_ISSUE), saved);
  const bad = parseIssueState(
    { ...saved, pr: "eight", counts: null },
    SAVED_ISSUE,
  );
  assert.equal(bad?.pr, null);
  assert.deepEqual(bad?.counts, { conflictFixes: 0, syncs: 0 });
  assert.equal(parseIssueState({ ...saved, stage: "fix" }, SAVED_ISSUE), null);
});

test("lifting a stop resumes the stage that stopped with its counts reset", () => {
  const stopped = {
    ...newIssueState(SAVED_ISSUE),
    stage: /** @type {const} */ ("stopped"),
    stoppedStage: /** @type {const} */ ("implement"),
    stopCode: "conflict",
    counts: { conflictFixes: CONFLICT_FIXES, syncs: SYNCS },
  };
  const lifted = resumeOf(stopped);
  assert.equal(lifted.stage, "implement");
  assert.equal(lifted.stopCode, null);
  assert.deepEqual(lifted.counts, { conflictFixes: 0, syncs: 0 });
});

test("a launch record whose session pushed to the wiki, written while the pipeline had one, still parses with its pushes", () => {
  const pushes = [
    { repo: "code", sha: "c".repeat(SHA1_HEX_LENGTH), at: LEASE.at },
    { repo: "wiki", sha: "d".repeat(SHA1_HEX_LENGTH), at: LEASE.at },
  ];
  const started = startedRecord({
    key: "developer-1",
    kind: "session",
    pid: 1,
    session: "session.jsonl",
  });
  const parsed = LAUNCH.safeParse({ ...started, pushes });
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data.pushes, pushes);
});

test("a merge authorization holds only for the code, wiki and inputs revision hardened", () => {
  const revision = { code: "c1", wiki: "w1", inputs: "i1" };
  const state = newIssueState(SAVED_ISSUE);
  const hardened = { ...state, hardened: revision };
  assert.equal(approvalHolds(hardened, revision), true);
  assert.equal(approvalHolds(hardened, { ...revision, code: "c2" }), false);
  assert.equal(approvalHolds(hardened, { ...revision, wiki: "w2" }), false);
  assert.equal(approvalHolds(hardened, { ...revision, inputs: "i2" }), false);
  // A review's approval, with no hardening, authorizes no merge.
  const reviewedOnly = {
    ...state,
    review: {
      ...state.review,
      verdict: /** @type {const} */ ("approve"),
      revision,
    },
  };
  assert.equal(approvalHolds(reviewedOnly, revision), false);
});
