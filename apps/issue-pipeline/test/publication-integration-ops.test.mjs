// @ts-check
// The merge and finish ops (src/ops/merge.ts, src/ops/merge-guard.ts,
// src/ops/finish-guard.ts) with the Reviewer's own integration: they merge and
// complete only the state's authorized revision (mergeAuthorization), which a
// receipt bound to the exact hardened revision moves to the integrated,
// checked one; a receipt bound to anything else authorizes nothing, and no
// review verdict authorizes a merge. The merge comment keeps the hardened head apart from
// the integrated one and says the security review follows, and the merge
// op refuses a draft rather than marking it ready.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approvalReply,
  branchMergeReply,
  mergeCommentReplies,
} from "./merge-op-fixtures.mjs";
import { finishReplies } from "./ops-finish-fixtures.mjs";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  mergeAuthority,
  PR,
  prView,
  savedListing,
  securityOf,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";
import { mergedAt } from "./publication-integration-fixtures.mjs";

const { merge } = await import("../src/ops/merge.ts");
const { finishWiki } = await import("../src/ops/finish.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @typedef {import("../src/state.ts").Revision} Revision */

const SHORT_SHA_LENGTH = 12;
const SECURITY_FOLLOWS =
  "Exact-result deterministic checks and a read-only security review of the merged result follow; the issue completes only if it finds nothing.";
const REVIEWED_CODE = "c0ffee00000000000000000000000000000000aa";
const NOT_AUTHORIZED_REVISION = /is not #7's authorized revision/u;
const NOT_BOUND = /merge authorization .* is not bound to the saved result/u;

/** @param {string | null} sha @returns {string} */
function short(sha) {
  return String(sha).slice(0, SHORT_SHA_LENGTH);
}

// Hardening passed REVIEWED_CODE; the Reviewer's own integration then
// checked the world's head from it.
/** @param {World} w @returns {{ reviewed: Revision, integrated: Revision }} */
function chainOf(w) {
  return {
    reviewed: { code: REVIEWED_CODE, inputs: "inputs-1" },
    integrated: { code: w.sha, inputs: "inputs-1" },
  };
}

/** @param {Revision} reviewed @param {{ reviewed: Revision, revision: Revision } | null} integration @param {object} [extra] */
function integratedState(reviewed, integration, extra = {}) {
  return approvedState(reviewed, { integration, ...extra });
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

test("merge merges the Reviewer's integrated head and its comment names the hardened head apart", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const state = integratedState(reviewed, { reviewed, revision: integrated });
  openAt(w, integrated);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha }),
    approvalReply(w),
    branchMergeReply(w),
    ...mergeAuthority(state),
    ...mergeCommentReplies(),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: w.mergeSha },
    }),
  ]);
  const reply = merge(w.cfg, mergeRequest(w, integrated, state));
  assert.deepEqual(reply, {
    merged: true,
    mergeCommit: w.mergeSha,
    headSha: w.sha,
  });
  const body =
    writes()
      .filter((args) => !args.includes("PATCH"))[2]
      ?.join(" ") ?? "";
  assert.ok(body.includes(`hardening passed on ${short(REVIEWED_CODE)}`));
  assert.ok(body.includes(`integrated it as ${short(w.sha)}`));
  assert.ok(body.includes("with no further review"));
  assert.ok(body.includes(SECURITY_FOLLOWS));
});

test("merge without an integration says hardening passed on the merged head", () => {
  const w = world();
  const approved = { code: w.sha, inputs: "inputs-1" };
  openAt(w, approved);
  fakeGh.reply([
    prView({ headRefOid: w.sha }),
    prView({ headRefOid: w.sha }),
    approvalReply(w),
    branchMergeReply(w),
    ...mergeAuthority(approvedState(approved)),
    ...mergeCommentReplies(),
    prView({
      headRefOid: w.sha,
      state: "MERGED",
      mergeCommit: { oid: w.mergeSha },
    }),
  ]);
  merge(w.cfg, mergeRequest(w, approved, approvedState(approved)));
  const body =
    writes()
      .filter((args) => !args.includes("PATCH"))[2]
      ?.join(" ") ?? "";
  assert.ok(body.includes("hardening passed on this commit"));
  assert.ok(body.includes(SECURITY_FOLLOWS));
  assert.equal(body.includes("integrated"), false);
});

test("merge refuses a revision the state doesn't authorize, a forged receipt's or a reviewed head included, writing nothing", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  openAt(w, integrated);
  const forged = integratedState(reviewed, {
    reviewed: { ...reviewed, code: "0ther" },
    revision: integrated,
  });
  const unbound = integratedState(reviewed, null);
  // A review that approved the head, with no hardening, authorizes nothing.
  const unhardened = approvedState(integrated, { hardened: null });
  for (const state of [forged, unbound, unhardened]) {
    fakeGh.reply([
      savedListing(approvedState(integrated)),
      prView({ headRefOid: w.sha }),
    ]);
    assert.throws(
      () => merge(w.cfg, mergeRequest(w, integrated, state)),
      NOT_AUTHORIZED_REVISION,
    );
    assert.deepEqual(writes(), []);
  }
});

test("merge refuses a draft at the approved head without marking it ready", () => {
  const w = world();
  const approved = { code: w.sha, inputs: "inputs-1" };
  openAt(w, approved);
  fakeGh.reply([
    savedListing(approvedState(approved)),
    prView({ headRefOid: w.sha, isDraft: true }),
  ]);
  const reply = merge(
    w.cfg,
    mergeRequest(w, approved, approvedState(approved)),
  );
  assert.deepEqual(reply, { merged: false, reason: "draft" });
  assert.deepEqual(writes(), []);
});

/** @param {Revision} receipt @param {object} state @returns {object} */
function doneAt(receipt, state) {
  return { ...state, stage: "done", lease: null, merged: receipt };
}

test("a claimed own merge finishes with original hardening and integration intact, only after saved exact security", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const receipt = mergedAt(w);
  const state = integratedState(
    reviewed,
    { reviewed, revision: integrated },
    {
      codeMerged: { pr: PR, sha: w.mergeSha },
      verifiedSha: w.mergeSha,
    },
  );
  const uncleared = doneAt(receipt, state);
  fakeGh.reply([savedListing(uncleared)]);
  const refused = finishWiki(w.cfg, { number: 7, state: uncleared });
  assert.equal("reason" in refused && refused.reason, "security");
  assert.deepEqual(writes(), []);

  const done = { ...uncleared, security: securityOf(receipt) };
  const before = structuredClone(done);
  fakeGh.reply([savedListing(done), ...finishReplies()]);
  assert.deepEqual(finishWiki(w.cfg, { number: 7, state: done }), {
    finished: true,
    closed: true,
  });
  assert.ok(
    writes().some((args) => args.join(" ").startsWith("issue close 7 ")),
  );
  assert.equal(
    writes().some(
      (args) =>
        args.join(" ").startsWith("pr merge ") ||
        args.includes("repos/o/r/merges"),
    ),
    false,
  );
  assert.deepEqual(done, before);
});

test("finish refuses an integrated head no receipt binds to the approval, changing nothing", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const forged = integratedState(reviewed, {
    reviewed: { ...reviewed, code: "0ther" },
    revision: integrated,
  });
  const receipt = mergedAt(w);
  const security = securityOf(receipt);
  for (const saved of [forged, integratedState(reviewed, null)]) {
    const done = { ...doneAt(receipt, saved), security };
    fakeGh.reply([savedListing(done)]);
    assert.throws(
      () => finishWiki(w.cfg, { number: 7, state: done }),
      NOT_BOUND,
    );
    assert.deepEqual(writes(), []);
  }
});

test("finish of an integrated head refuses a security review of the pre-merge head instead of the merge commit", () => {
  const w = world();
  const { reviewed, integrated } = chainOf(w);
  const state = integratedState(reviewed, { reviewed, revision: integrated });
  const receipt = mergedAt(w);
  for (const revision of [integrated, reviewed]) {
    const done = { ...doneAt(receipt, state), security: securityOf(revision) };
    fakeGh.reply([savedListing(done)]);
    const reply = finishWiki(w.cfg, { number: 7, state: done });
    assert.equal("reason" in reply && reply.reason, "security");
    assert.deepEqual(writes(), []);
  }
});
