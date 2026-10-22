// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { executionFixture } from "./execution-runtime-test-kit.mjs";

const { writeState } = await import("../src/saved-state.ts");
const { sameRevision } = await import("../src/state.ts");
const WORK = 420;
const MERGED = 421;
const SECURITY = 422;
const PR = 47;
const WIDTH = 40;
const POLICY_WIDTH = 64;
const HEAD = "a".repeat(WIDTH);
const NEXT_HEAD = "b".repeat(WIDTH);
const RESULT = "c".repeat(WIDTH);
const TARGET = "d".repeat(WIDTH);
const INPUTS = "trusted-inputs";
const SECURITY_COMMENT = 71;
const WRONG_ISSUE = /a state for #421 can't be saved on #420/u;
const HELD = /assigned|execution|authority|binding|reconcil/u;

test("bound saves retain branch, draft and head while allowing existing explicit head movement", () => {
  const fixture = executionFixture(WORK);
  const state = fixture.claim();
  const draft = fixture.save({ ...state, pr: PR, headSha: HEAD });
  assert.equal(draft.pr, PR);
  const moved = fixture.save({ ...draft, headSha: NEXT_HEAD });
  assert.equal(moved.headSha, NEXT_HEAD);
  assert.deepEqual(moved.execution, state.execution);
  const stale = fixture.save({ ...state, headSha: null, pr: null });
  assert.equal(stale.headSha, NEXT_HEAD);
  assert.equal(stale.pr, PR);
  assert.equal(stale.branch, state.branch);
  const before = fixture.writes();
  assert.throws(() => fixture.save({ ...stale, branch: "wrong" }), HELD);
  assert.throws(() => fixture.save({ ...stale, number: MERGED }), WRONG_ISSUE);
  assert.deepEqual(fixture.writes(), before);
});

test("stale saves cannot clear attempted merge, observed truth, own receipt or Security evidence", () => {
  const fixture = executionFixture(MERGED);
  const state = fixture.claim();
  const authorized = {
    code: HEAD,
    inputs: INPUTS,
    wiki: "historical-wiki-head",
  };
  const merged = { ...authorized, code: RESULT };
  const target = {
    repo: fixture.cfg.repo,
    branch: fixture.cfg.baseBranch,
    sha: TARGET,
  };
  const durable = {
    ...state,
    headSha: HEAD,
    pr: PR,
    hardened: authorized,
    merged,
    codeMerged: { pr: PR, sha: RESULT },
    mergeAttempt: {
      repo: fixture.cfg.repo,
      pr: PR,
      target: fixture.cfg.baseBranch,
      branch: state.branch ?? "",
      authorized,
      hardened: authorized,
      integration: null,
      result: RESULT,
      reads: 1,
    },
    security: { revision: merged, commentId: SECURITY_COMMENT, finding: null },
    resultSecurity: {
      revision: { ...merged, policy: "e".repeat(POLICY_WIDTH) },
      target,
      commentId: SECURITY_COMMENT,
      finding: null,
    },
  };
  // Deterministic merge operations, not a role snapshot, establish these facts.
  writeState(fixture.cfg, fixture.issue, durable);
  const saved = fixture.save(state);
  assert.deepEqual(saved.mergeAttempt, durable.mergeAttempt);
  assert.deepEqual(saved.hardened, authorized);
  assert.deepEqual(saved.codeMerged, durable.codeMerged);
  assert.deepEqual(saved.merged, merged);
  assert.deepEqual(saved.security, durable.security);
  assert.deepEqual(saved.resultSecurity, durable.resultSecurity);
  assert.equal(saved.headSha, HEAD);
  assert.equal(saved.pr, PR);
  assert.equal(sameRevision(merged, { code: RESULT, inputs: INPUTS }), false);
});

test("candidate rejection survives a stale save, but new code can replace obsolete clearance", () => {
  const fixture = executionFixture(SECURITY);
  const state = fixture.claim();
  const revision = { code: HEAD, inputs: INPUTS };
  const target = {
    repo: fixture.cfg.repo,
    branch: fixture.cfg.baseBranch,
    sha: TARGET,
  };
  const security = {
    phase: /** @type {const} */ ("candidate"),
    target,
    revision,
    commentId: SECURITY_COMMENT,
    finding: { category: /** @type {const} */ ("abuse-risk"), reason: "held" },
  };
  writeState(fixture.cfg, fixture.issue, { ...state, headSha: HEAD, security });
  const saved = fixture.save({ ...state, headSha: HEAD });
  assert.deepEqual(saved.security, security);
  const cleared = {
    ...security,
    revision: { ...revision, code: NEXT_HEAD },
    finding: null,
  };
  const moved = fixture.save({
    ...saved,
    headSha: NEXT_HEAD,
    security: cleared,
  });
  assert.equal(moved.headSha, NEXT_HEAD);
  assert.deepEqual(moved.security, cleared);
});
