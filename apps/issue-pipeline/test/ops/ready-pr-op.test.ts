// The ready-pr op (src/ops/ready-pr.ts), the only op that marks an issue's
// draft PR ready: only for the exact revision the Reviewer's hardening
// authorizes, saved at review or merge before the call. Integration history
// grants no authorization. Hardening must hold for the revision read fresh, with
// GitHub showing the PR open at the authorized head. No review verdict
// stands in for hardening. Safe to repeat; a failed ready fails the op.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueState, Revision } from "../../src/state.ts";
import { setCurrentRevision } from "./fake-ops-publish-revision.ts";
import type { World } from "./ops-publish-test-kit.ts";
import {
  approvedState,
  fakeGh,
  hardenedApproval,
  PR,
  REPO,
  readyView,
  savedListing,
  world,
  writes,
} from "./ops-publish-test-kit.ts";

const { readyPr: readyPrOp }: typeof import("../../src/ops/ready-pr.ts") =
  await import("../../src/ops/ready-pr.ts");

const READY_CALL: string[] = ["pr", "ready", String(PR), "-R", REPO];
const NO_HARDENED_AUTHORIZATION = /no hardened authorization/u;
const NOT_SAVED = /save it before ready-pr/u;
const NOT_CURRENT = /doesn't hold for its current revision/u;
const NOT_AT_AUTHORIZED = /not open at the authorized/u;
const NOT_ISSUE_BRANCH = /not from o\/r's agent\/issue-7/u;
const STILL_DRAFT = /GitHub shows a draft/u;
const READY_FAILED = /gh pr ready/u;
const TARGET_REFUSAL = /targets .+, not integration/u;

function reviewedOf(w: World): Revision {
  return { code: w.sha, inputs: "inputs-1" };
}

function current(revision: Revision): void {
  setCurrentRevision({
    revision,
    baseSha: "base",
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: "x" },
  });
}

function readyPr(w: World, state: IssueState): unknown {
  return readyPrOp(w.cfg, { number: 7, state });
}

test("ready-pr marks the draft ready once the hardened authorization is saved and current", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  current(approved);
  fakeGh.reply([
    savedListing(state),
    readyView({ headRefOid: w.sha }),
    { when: "pr ready 50" },
    readyView({ headRefOid: w.sha, isDraft: false }),
  ]);
  assert.deepEqual(readyPr(w, state), { pr: PR, ready: true });
  assert.deepEqual(writes(), [READY_CALL]);
});

test("ready-pr on a PR already ready succeeds again without a write, from a merge-stage save too", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved, { stage: "merge" });
  current(approved);
  fakeGh.reply([
    savedListing(state),
    readyView({ headRefOid: w.sha, isDraft: false }),
  ]);
  assert.deepEqual(readyPr(w, state), { pr: PR, ready: true });
  assert.deepEqual(writes(), []);
});

test("ready-pr requires fresh hardening after integration changes the head", () => {
  const w = world();
  const reviewed = { ...reviewedOf(w), code: "c0ffee" };
  const integrated = reviewedOf(w);
  const state = approvedState(reviewed, {
    stage: "merge",
    hardened: reviewed,
    integration: { reviewed, revision: integrated },
  });
  assert.notEqual(reviewed.code, integrated.code);
  current(integrated);
  fakeGh.reply([savedListing(state), readyView({ headRefOid: w.sha })]);
  assert.throws(() => readyPr(w, state), NOT_CURRENT);
  assert.deepEqual(writes(), []);
  const fresh = { ...state, hardened: integrated };
  fakeGh.reply([
    savedListing(fresh),
    readyView({ headRefOid: w.sha }),
    { when: "pr ready 50" },
    readyView({ headRefOid: w.sha, isDraft: false }),
  ]);
  assert.deepEqual(readyPr(w, fresh), { pr: PR, ready: true });
  assert.deepEqual(writes(), [READY_CALL]);
});

test("ready-pr fails, never swallowing it, when gh's ready fails or GitHub still shows a draft", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  current(approved);
  fakeGh.reply([
    savedListing(state),
    readyView({ headRefOid: w.sha }),
    { when: "pr ready 50", code: 1, stderr: "GraphQL: refused" },
  ]);
  assert.throws(() => readyPr(w, state), READY_FAILED);
  fakeGh.reply([
    savedListing(state),
    readyView({ headRefOid: w.sha }),
    { when: "pr ready 50" },
    readyView({ headRefOid: w.sha }),
  ]);
  assert.throws(() => readyPr(w, state), STILL_DRAFT);
});

test("ready-pr refuses a state no hardening authorized, whatever its review verdict, writing nothing", () => {
  const w = world();
  const approved = reviewedOf(w);
  current(approved);
  const state = hardenedApproval(approved, { hardened: null });
  fakeGh.reply([savedListing(state), readyView({ headRefOid: w.sha })]);
  assert.throws(() => readyPr(w, state), NO_HARDENED_AUTHORIZATION);
  assert.deepEqual(writes(), []);
});

test("ready-pr refuses hardening of another revision, or a receipt bound to one, writing nothing", () => {
  const w = world();
  const approved = reviewedOf(w);
  current(approved);
  const other = { ...approved, code: "0ld" };
  const states = [
    hardenedApproval(approved, { hardened: other }),
    hardenedApproval(approved, {
      hardened: other,
      integration: {
        reviewed: { ...other, code: "0ther" },
        revision: approved,
      },
    }),
  ];
  for (const state of states) {
    fakeGh.reply([savedListing(state), readyView({ headRefOid: w.sha })]);
    assert.throws(() => readyPr(w, state), NOT_CURRENT);
    assert.deepEqual(writes(), []);
  }
});

test("ready-pr refuses an authorization not saved first at review or merge, writing nothing", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  current(approved);
  const savedStates = [
    { ...state, hardened: null },
    { ...state, hardened: { ...approved, code: "0ld" } },
    { ...state, stage: "implement" },
    { ...state, pr: 51 },
  ];
  for (const saved of savedStates) {
    fakeGh.reply([savedListing(saved), readyView({ headRefOid: w.sha })]);
    assert.throws(() => readyPr(w, state), NOT_SAVED);
    assert.deepEqual(writes(), []);
  }
  fakeGh.reply([
    { when: "issues/7/comments?per_page", stdout: "" },
    readyView({ headRefOid: w.sha }),
  ]);
  assert.throws(() => readyPr(w, state), NOT_SAVED);
  assert.deepEqual(writes(), []);
});

test("ready-pr accepts unchanged saved hardening despite different integration history", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  const saved = {
    ...state,
    integration: { reviewed: approved, revision: { ...approved, code: "c2" } },
  };
  assert.notDeepEqual(saved.integration, state.integration);
  assert.deepEqual(saved.hardened, state.hardened);
  current(approved);
  fakeGh.reply([
    savedListing(saved),
    readyView({ headRefOid: w.sha }),
    { when: "pr ready 50" },
    readyView({ headRefOid: w.sha, isDraft: false }),
  ]);
  assert.deepEqual(readyPr(w, state), { pr: PR, ready: true });
  assert.deepEqual(writes(), [READY_CALL]);
});

test("ready-pr refuses a revision that moved since hardening, writing nothing", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  for (const moved of [
    { ...approved, code: "0ther" },
    { ...approved, wiki: "w2" },
    { ...approved, inputs: "inputs-2" },
  ]) {
    current(moved);
    fakeGh.reply([savedListing(state), readyView({ headRefOid: w.sha })]);
    assert.throws(() => readyPr(w, state), NOT_CURRENT);
    assert.deepEqual(writes(), []);
  }
});

test("ready-pr refuses a PR GitHub shows at another head, closed or from another branch", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  current(approved);
  for (const view of [
    { headRefOid: "0ther" },
    { headRefOid: w.sha, state: "CLOSED" },
  ]) {
    fakeGh.reply([savedListing(state), readyView(view)]);
    assert.throws(() => readyPr(w, state), NOT_AT_AUTHORIZED);
    assert.deepEqual(writes(), []);
  }
  for (const view of [
    { headRefOid: w.sha, headRefName: "evil" },
    { headRefOid: w.sha, isCrossRepository: true },
  ]) {
    fakeGh.reply([savedListing(state), readyView(view)]);
    assert.throws(() => readyPr(w, state), NOT_ISSUE_BRANCH);
    assert.deepEqual(writes(), []);
  }
});

for (const baseRefName of ["main", "other"]) {
  test(`ready-pr refuses exact authorized head retargeted to ${baseRefName} after revision read`, () => {
    const w = world();
    const approved = reviewedOf(w);
    const state = hardenedApproval(approved);
    current(approved);
    fakeGh.reply([
      savedListing(state),
      readyView({ headRefOid: w.sha, baseRefName }),
    ]);
    assert.throws(() => readyPr(w, state), TARGET_REFUSAL);
    assert.deepEqual(writes(), []);
  });
}

test("ready-pr refuses a wrong-base readiness receipt", () => {
  const w = world();
  const approved = reviewedOf(w);
  const state = hardenedApproval(approved);
  current(approved);
  fakeGh.reply([
    savedListing(state),
    readyView({ headRefOid: w.sha }),
    { when: "pr ready 50" },
    readyView({ headRefOid: w.sha, isDraft: false, baseRefName: "main" }),
  ]);
  assert.throws(() => readyPr(w, state), TARGET_REFUSAL);
  assert.deepEqual(writes(), [READY_CALL]);
});
