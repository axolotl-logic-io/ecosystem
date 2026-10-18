// @ts-check
// The approval chain (src/state.ts): an approval permits the revision the
// final review approved, or the one revision the Reviewer's own integration
// checked from exactly that approval (state.integration), never a receipt's
// head for another review or other trusted inputs. The original
// review.revision is kept as the review saw it, and a state saved before
// `hardened` and `integration` existed reads them as null.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { approvalHolds, approvedRevision, ISSUE_STATE, newIssueState } =
  await import("../src/state.ts");
const { parseIssueState, stateBody, parseStateBody } = await import(
  "../src/saved-state.ts"
);

/** @typedef {import("../src/state.ts").IssueState} IssueState */
/** @typedef {import("../src/state.ts").Revision} Revision */

const ISSUE = 12;
const PR = 3;
/** @type {Revision} */
const REVIEWED = { code: "c1", wiki: "w1", inputs: "i1" };
/** @type {Revision} */
const INTEGRATED = { code: "c2", wiki: "w2", inputs: "i1" };

/** @param {"approve" | "changes" | null} verdict @param {object} [extra] @returns {IssueState} */
function reviewed(verdict, extra = {}) {
  return {
    ...newIssueState(ISSUE),
    stage: "merge",
    pr: PR,
    review: {
      round: 0,
      verdict,
      commentId: null,
      findings: [],
      revision: REVIEWED,
    },
    hardened: REVIEWED,
    ...extra,
  };
}

test("a new state has no hardening checkpoint and no integration receipt", () => {
  const state = newIssueState(ISSUE);
  assert.equal(state.hardened, null);
  assert.equal(state.integration, null);
  assert.equal(approvedRevision(state), null);
});

test("a version 2 state saved before hardened and integration existed reads them as null", () => {
  const { hardened: _h, integration: _i, ...older } = reviewed("approve");
  const parsed = parseIssueState(older, ISSUE);
  assert.ok(parsed !== null);
  assert.equal(parsed.hardened, null);
  assert.equal(parsed.integration, null);
  assert.deepEqual(approvedRevision(parsed), REVIEWED);
});

test("the approved revision is the reviewed one when nothing integrated it", () => {
  const state = reviewed("approve");
  assert.deepEqual(approvedRevision(state), REVIEWED);
  assert.equal(approvalHolds(state, REVIEWED), true);
  assert.equal(approvalHolds(state, INTEGRATED), false);
});

test("the Reviewer's own integration moves the approval to its checked revision and keeps the review's", () => {
  const state = reviewed("approve", {
    integration: { reviewed: REVIEWED, revision: INTEGRATED },
  });
  assert.deepEqual(approvedRevision(state), INTEGRATED);
  assert.equal(approvalHolds(state, INTEGRATED), true);
  assert.equal(approvalHolds(state, REVIEWED), false);
  assert.deepEqual(state.review.revision, REVIEWED);
  const saved = parseStateBody(stateBody(ISSUE, state), ISSUE);
  assert.deepEqual(saved?.integration, {
    reviewed: REVIEWED,
    revision: INTEGRATED,
  });
  assert.deepEqual(saved?.review.revision, REVIEWED);
});

test("a receipt bound to another review's revision approves nothing new", () => {
  const forged = reviewed("approve", {
    integration: {
      reviewed: { ...REVIEWED, code: "c0" },
      revision: INTEGRATED,
    },
  });
  assert.deepEqual(approvedRevision(forged), REVIEWED);
  assert.equal(approvalHolds(forged, INTEGRATED), false);
  const otherWiki = reviewed("approve", {
    integration: {
      reviewed: { ...REVIEWED, wiki: "w0" },
      revision: INTEGRATED,
    },
  });
  assert.equal(approvalHolds(otherWiki, INTEGRATED), false);
});

test("a receipt that changes the trusted inputs reads as none", () => {
  const raw = reviewed("approve", {
    integration: {
      reviewed: REVIEWED,
      revision: { ...INTEGRATED, inputs: "i2" },
    },
  });
  const parsed = ISSUE_STATE.parse(raw);
  assert.equal(parsed.integration, null);
  assert.deepEqual(approvedRevision(parsed), REVIEWED);
  assert.equal(approvalHolds(parsed, { ...INTEGRATED, inputs: "i2" }), false);
});

test("no receipt approves a revision once the verdict is changes or the review is gone", () => {
  const integration = { reviewed: REVIEWED, revision: INTEGRATED };
  for (const verdict of /** @type {const} */ (["changes", null])) {
    const state = reviewed(verdict, { integration });
    assert.equal(approvedRevision(state), null);
    assert.equal(approvalHolds(state, INTEGRATED), false);
    assert.equal(approvalHolds(state, REVIEWED), false);
  }
  const unreviewed = reviewed("approve", { integration });
  const gone = {
    ...unreviewed,
    review: { ...unreviewed.review, revision: null },
  };
  assert.equal(approvedRevision(gone), null);
  assert.equal(approvalHolds(gone, INTEGRATED), false);
});

test("a malformed hardened or integration field reads as null and keeps the rest", () => {
  const parsed = parseIssueState(
    {
      ...reviewed("approve"),
      hardened: { code: 1 },
      integration: { reviewed: REVIEWED },
    },
    ISSUE,
  );
  assert.ok(parsed !== null);
  assert.equal(parsed.hardened, null);
  assert.equal(parsed.integration, null);
  assert.equal(parsed.pr, PR);
  assert.deepEqual(approvedRevision(parsed), REVIEWED);
});
