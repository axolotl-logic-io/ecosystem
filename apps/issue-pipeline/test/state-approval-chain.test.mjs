// @ts-check
// The merge authorization chain (src/state.ts): a merge is authorized for
// the revision that passed the Reviewer's hardening, or the one revision the
// Reviewer's own integration checked from exactly that hardened revision
// (state.integration), never a receipt's head for another revision or other
// trusted inputs, and never by a review verdict alone. The security review
// of the merged result (state.security) parses as saved, its finding
// included. A state saved before these fields existed reads them as null.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { approvalHolds, mergeAuthorization, ISSUE_STATE, newIssueState } =
  await import("../src/state.ts");
const { parseIssueState, stateBody, parseStateBody } = await import(
  "../src/saved-state.ts"
);

/** @typedef {import("../src/state.ts").IssueState} IssueState */
/** @typedef {import("../src/state.ts").Revision} Revision */

const ISSUE = 12;
const PR = 3;
const SECURITY_COMMENT = 44;
/** @type {Revision} */
const HARDENED = { code: "c1", wiki: "w1", inputs: "i1" };
/** @type {Revision} */
const INTEGRATED = { code: "c2", wiki: "w2", inputs: "i1" };

/** @param {object} [extra] @returns {IssueState} */
function hardenedState(extra = {}) {
  return {
    ...newIssueState(ISSUE),
    stage: "merge",
    pr: PR,
    hardened: HARDENED,
    ...extra,
  };
}

test("a new state has no hardening, no integration receipt and no security review", () => {
  const state = newIssueState(ISSUE);
  assert.equal(state.hardened, null);
  assert.equal(state.integration, null);
  assert.equal(state.security, null);
  assert.equal(mergeAuthorization(state), null);
});

test("a version 2 state saved before hardened, integration and security existed reads them as null and authorizes nothing", () => {
  const {
    hardened: _h,
    integration: _i,
    security: _s,
    ...older
  } = hardenedState({
    review: {
      round: 0,
      verdict: "approve",
      commentId: null,
      findings: [],
      revision: HARDENED,
    },
  });
  const parsed = parseIssueState(older, ISSUE);
  assert.ok(parsed !== null);
  assert.equal(parsed.hardened, null);
  assert.equal(parsed.integration, null);
  assert.equal(parsed.security, null);
  assert.equal(mergeAuthorization(parsed), null);
  assert.equal(approvalHolds(parsed, HARDENED), false);
});

test("the authorized revision is the hardened one when nothing integrated it, whatever the review verdict", () => {
  const state = hardenedState();
  assert.deepEqual(mergeAuthorization(state), HARDENED);
  assert.equal(approvalHolds(state, HARDENED), true);
  assert.equal(approvalHolds(state, INTEGRATED), false);
  assert.equal(approvalHolds(state, { ...HARDENED, inputs: "i2" }), false);
});

test("the Reviewer's own integration moves the authorization to its checked revision and keeps the hardened one", () => {
  const state = hardenedState({
    integration: { reviewed: HARDENED, revision: INTEGRATED },
  });
  assert.deepEqual(mergeAuthorization(state), INTEGRATED);
  assert.equal(approvalHolds(state, INTEGRATED), true);
  assert.equal(approvalHolds(state, HARDENED), false);
  const saved = parseStateBody(stateBody(ISSUE, state), ISSUE);
  assert.deepEqual(saved?.integration, {
    reviewed: HARDENED,
    revision: INTEGRATED,
  });
  assert.deepEqual(saved?.hardened, HARDENED);
});

test("a receipt bound to another revision than the hardened one authorizes nothing new", () => {
  for (const reviewed of [
    { ...HARDENED, code: "c0" },
    { ...HARDENED, wiki: "w0" },
  ]) {
    const forged = hardenedState({
      integration: { reviewed, revision: INTEGRATED },
    });
    assert.deepEqual(mergeAuthorization(forged), HARDENED);
    assert.equal(approvalHolds(forged, INTEGRATED), false);
  }
  const unhardened = hardenedState({
    hardened: null,
    integration: { reviewed: HARDENED, revision: INTEGRATED },
  });
  assert.equal(mergeAuthorization(unhardened), null);
  assert.equal(approvalHolds(unhardened, INTEGRATED), false);
});

test("a receipt that changes the trusted inputs reads as none", () => {
  const raw = hardenedState({
    integration: {
      reviewed: HARDENED,
      revision: { ...INTEGRATED, inputs: "i2" },
    },
  });
  const parsed = ISSUE_STATE.parse(raw);
  assert.equal(parsed.integration, null);
  assert.deepEqual(mergeAuthorization(parsed), HARDENED);
  assert.equal(approvalHolds(parsed, { ...INTEGRATED, inputs: "i2" }), false);
});

test("a security review saves its exact revision and its finding, or none", () => {
  const merged = { ...INTEGRATED, code: "m1" };
  const finding = { category: "rights", reason: "copies a licensed text" };
  for (const security of [
    { revision: merged, commentId: SECURITY_COMMENT, finding: null },
    { revision: merged, commentId: SECURITY_COMMENT, finding },
  ]) {
    const saved = parseStateBody(
      stateBody(ISSUE, hardenedState({ security })),
      ISSUE,
    );
    assert.deepEqual(saved?.security, security);
  }
});

test("a malformed hardened, integration or security field reads as null and keeps the rest", () => {
  const revision = INTEGRATED;
  for (const security of [
    { revision, commentId: null, finding: null },
    { revision, commentId: SECURITY_COMMENT },
    {
      revision,
      commentId: SECURITY_COMMENT,
      finding: { category: "style", reason: "x" },
    },
    { revision, commentId: SECURITY_COMMENT, finding: { category: "rights" } },
  ]) {
    const parsed = parseIssueState(
      {
        ...hardenedState(),
        hardened: { code: 1 },
        integration: { reviewed: HARDENED },
        security,
      },
      ISSUE,
    );
    assert.ok(parsed !== null);
    assert.equal(parsed.hardened, null);
    assert.equal(parsed.integration, null);
    assert.equal(parsed.security, null);
    assert.equal(parsed.pr, PR);
  }
});
