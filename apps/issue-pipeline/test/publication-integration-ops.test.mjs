// @ts-check
// The merge and publish ops (src/ops/merge.ts, src/ops/publication-guard.ts)
// with the Reviewer's own integration: they merge and publish only the
// state's approved revision (approvedRevision), which a receipt bound to the
// exact reviewed revision moves to the integrated, checked one; a receipt
// bound to anything else approves nothing. The merge comment keeps the
// reviewed head apart from the integrated one, and the merge op refuses a
// draft rather than marking it ready.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  MERGE_COMMIT,
  PR,
  prView,
  publishOf,
  refusalOf,
  savedListing,
  wikiRef,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { merge } = await import("../src/ops/merge.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @typedef {{ code: string | null, wiki: string | null, inputs: string }} Revision */

const SHORT_SHA_LENGTH = 12;
const REVIEWED_CODE = "c0ffee00000000000000000000000000000000aa";
const NOT_APPROVED_REVISION = /is not #7's approved revision/u;

/** @param {string | null} sha @returns {string} */
function short(sha) {
  return String(sha).slice(0, SHORT_SHA_LENGTH);
}

// The final review approved REVIEWED_CODE; the Reviewer's own integration
// then checked the world's head (and wiki head) from it.
/** @param {World} w @returns {{ reviewed: Revision, integrated: Revision }} */
function chainOf(w) {
  return {
    reviewed: { code: REVIEWED_CODE, wiki: null, inputs: "inputs-1" },
    integrated: { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" },
  };
}

/** @param {Revision} reviewed @param {{ reviewed: Revision, revision: Revision } | null} integration @param {object} [extra] */
function integratedState(reviewed, integration, extra = {}) {
  return approvedState(reviewed, {
    hardened: reviewed,
    integration,
    ...extra,
  });
}

/** @param {World} w @param {Revision} revision @returns {void} */
function openAt(w, revision) {
  setCurrentRevision({
    revision,
    baseSha: "base",
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

/** @param {World} w @param {Revision} revision @param {object} state @returns {object} */
function mergeRequest(w, revision, state) {
  return {
    number: 7,
    state,
    expectedSha: w.sha,
    revision,
    mergeQueue: null,
    summary: "S",
  };
}

test("merge merges the Reviewer's integrated head and its comment names the reviewed head apart", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const state = integratedState(reviewed, { reviewed, revision: integrated });
  openAt(w, integrated);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    { when: "pr merge 50" },
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  const reply = merge(w.cfg, mergeRequest(w, integrated, state));
  assert.deepEqual(reply, {
    merged: true,
    mergeCommit: MERGE_COMMIT,
    headSha: w.sha,
  });
  const body = writes()[1]?.join(" ") ?? "";
  assert.ok(body.includes(`final review approved ${short(REVIEWED_CODE)}`));
  assert.ok(body.includes(`integrated it as ${short(w.sha)}`));
  assert.ok(body.includes("with no further review"));
});

test("merge without an integration says the merged head is the reviewed one", () => {
  const w = world();
  const approved = { code: w.sha, wiki: null, inputs: "inputs-1" };
  openAt(w, approved);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    { when: "pr merge 50" },
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: MERGE_COMMIT },
    }),
  ]);
  merge(w.cfg, mergeRequest(w, approved, approvedState(approved)));
  const body = writes()[1]?.join(" ") ?? "";
  assert.ok(body.includes("every blocking review finding is resolved"));
  assert.equal(body.includes("integrated"), false);
});

test("merge refuses a revision the state doesn't approve, a forged receipt's head included, writing nothing", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  openAt(w, integrated);
  const forged = integratedState(reviewed, {
    reviewed: { ...reviewed, code: "0ther" },
    revision: integrated,
  });
  const unbound = integratedState(reviewed, null);
  for (const state of [forged, unbound]) {
    fakeGh.reply([prView({ headRefOid: w.sha })]);
    assert.throws(
      () => merge(w.cfg, mergeRequest(w, integrated, state)),
      NOT_APPROVED_REVISION,
    );
    assert.deepEqual(writes(), []);
  }
});

test("merge refuses a draft at the approved head without marking it ready", () => {
  const w = world();
  const approved = { code: w.sha, wiki: null, inputs: "inputs-1" };
  openAt(w, approved);
  fakeGh.reply([prView({ headRefOid: w.sha, isDraft: true })]);
  const reply = merge(
    w.cfg,
    mergeRequest(w, approved, approvedState(approved)),
  );
  assert.deepEqual(reply, { merged: false, reason: "draft" });
  assert.deepEqual(writes(), []);
});

// GitHub says PR #50 merged the integrated head w.sha as MERGE_COMMIT.
/** @param {World} w @returns {void} */
function mergedAt(w) {
  setCurrentRevision({
    revision: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: MERGE_COMMIT,
      headSha: w.sha,
    },
  });
}

/** @param {Revision} revision @param {object} state @returns {object} */
function publishRequest(revision, state) {
  return { number: 7, state, expectedWiki: revision.wiki, revision };
}

test("publish after the merge of an integrated head publishes the integrated wiki head", () => {
  const w = world({ wiki: true });
  const { reviewed, integrated } = chainOf(w);
  const state = integratedState(reviewed, { reviewed, revision: integrated });
  const receipt = { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" };
  mergedAt(w);
  fakeGh.reply([savedListing({ ...state, merged: receipt })]);
  const reply = publishOf(w.cfg, publishRequest(integrated, state));
  assert.equal(reply.published, true);
  assert.equal(wikiRef(w, "master"), w.wikiSha);
});

test("publish refuses an integrated head no receipt binds to the approval, in the request or the saved state", () => {
  const w = world({ wiki: true });
  const { reviewed, integrated } = chainOf(w);
  const bound = integratedState(reviewed, { reviewed, revision: integrated });
  const forged = integratedState(reviewed, {
    reviewed: { ...reviewed, code: "0ther" },
    revision: integrated,
  });
  const receipt = { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" };
  mergedAt(w);
  fakeGh.reply([savedListing({ ...forged, merged: receipt })]);
  assert.equal(
    refusalOf(w.cfg, publishRequest(integrated, forged)),
    "unapproved",
  );
  for (const saved of [forged, integratedState(reviewed, null)]) {
    fakeGh.reply([savedListing({ ...saved, merged: receipt })]);
    assert.equal(
      refusalOf(w.cfg, publishRequest(integrated, bound)),
      "no-receipt",
    );
  }
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});
