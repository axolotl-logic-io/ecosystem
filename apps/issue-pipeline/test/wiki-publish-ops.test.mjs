// @ts-check
// The publish op (src/ops/publish.ts, src/wiki-publication.ts): after fresh
// source and merged-PR gates, and a saved security review that found
// nothing at exactly the merged result, it fast-forwards the wiki to
// exactly the authorized wiki head, never rebasing, and changes nothing on
// GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  MERGE_COMMIT,
  moveWiki,
  PR,
  publishOf,
  refusalOf,
  savedListing,
  securityOf,
  sh,
  wikiRef,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
// A published commit's short sha, as the publish op names it.
const SHORT_SHA_LENGTH = 12;
const NOT_THE_MERGE_COMMIT = /not PR #50's merge commit/u;
/** @typedef {{ code: string | null, wiki: string | null, inputs: string }} Revision */

/** @param {World} w @returns {Revision} */
function approvedOf(w) {
  return { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" };
}

// GitHub says PR #50 merged head w.sha as MERGE_COMMIT; inputs unchanged.
/** @param {World} w @param {{ inputs?: string, state?: "OPEN" | "MERGED" }} [options] @returns {void} */
function merged(w, { inputs = "inputs-1", state = "MERGED" } = {}) {
  let mergeCommit = null;
  if (state === "MERGED") {
    mergeCommit = MERGE_COMMIT;
  }
  setCurrentRevision({
    revision: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs },
    baseSha: "base",
    pr: { number: PR, state, mergeCommit, headSha: w.sha },
  });
}

// The merged result of `approved`: GitHub's merge commit, the wiki head and
// the inputs, which the security review must clear.
/** @param {Revision} approved @returns {Revision} */
function resultOf(approved) {
  return { code: MERGE_COMMIT, wiki: approved.wiki, inputs: approved.inputs };
}

// The job's own merge saved its partial receipt: still at stage merge, its
// merged naming GitHub's merge commit with the approved wiki and inputs, and
// the security review of the merged result found nothing.
/** @param {Revision} approved @param {object} [receipt] @returns {void} */
function savedReceipt(approved, receipt = {}) {
  const security = securityOf(resultOf(approved));
  const receiptMerged = { ...resultOf(approved), ...receipt };
  fakeGh.reply([
    savedListing(approvedState(approved, { merged: receiptMerged, security })),
  ]);
}

/** @param {Revision} approved @param {object} [extra] @returns {object} */
function request(approved, extra = {}) {
  return {
    number: 7,
    state: approvedState(approved),
    expectedWiki: approved.wiki,
    revision: approved,
    ...extra,
  };
}

test("publish after the job's own merge fast-forwards the wiki to the approved head and deletes agent/issue-7", () => {
  const w = world({ wiki: true });
  merged(w);
  savedReceipt(approvedOf(w));
  const reply = publishOf(w.cfg, request(approvedOf(w)));
  const short = String(w.wikiSha).slice(0, SHORT_SHA_LENGTH);
  assert.deepEqual(reply, {
    published: true,
    sha: w.wikiSha,
    commits: [`${short} page`],
    alreadyPublished: false,
  });
  assert.equal(wikiRef(w, "master"), w.wikiSha);
  assert.equal(wikiRef(w, "agent/issue-7"), "");
  assert.deepEqual(writes(), []);
});

test("publish again after a crash succeeds without pushing anything new", () => {
  const w = world({ wiki: true });
  merged(w);
  savedReceipt(approvedOf(w));
  publishOf(w.cfg, request(approvedOf(w)));
  const again = publishOf(w.cfg, request(approvedOf(w)));
  assert.deepEqual(again, {
    published: true,
    sha: w.wikiSha,
    commits: [],
    alreadyPublished: true,
  });
  assert.equal(wikiRef(w, "master"), w.wikiSha);
});

test("publish refuses a wiki that moved past the approved head, and never rebases", () => {
  const w = world({ wiki: true });
  const moved = moveWiki(w);
  merged(w);
  savedReceipt(approvedOf(w));
  const reply = publishOf(w.cfg, request(approvedOf(w)));
  assert.equal(reply.published, false);
  assert.equal("reason" in reply && reply.reason, "wiki-behind");
  assert.equal(wikiRef(w, "master"), moved);
  assert.equal(sh(`git -C ${w.wikiDir} rev-parse HEAD`), w.wikiSha);
});

test("publish refuses changed trusted inputs, an open PR and a revision hardening didn't authorize", () => {
  const w = world({ wiki: true });
  const approved = approvedOf(w);
  merged(w, { inputs: "inputs-2" });
  assert.equal(refusalOf(w.cfg, request(approved)), "stale");
  merged(w, { state: "OPEN" });
  assert.equal(refusalOf(w.cfg, request(approved)), "not-merged");
  merged(w);
  const unapproved = request(approved, {
    state: approvedState(approved, { hardened: null }),
  });
  assert.equal(refusalOf(w.cfg, unapproved), "unapproved");
  const otherHardened = request(approved, {
    state: approvedState(approved, { hardened: { ...approved, code: "0ld" } }),
  });
  assert.equal(refusalOf(w.cfg, otherHardened), "unapproved");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("publish needs the saved own-merge receipt for original-head authorization, or confirmed postmerge hardening", () => {
  const w = world({ wiki: true });
  merged(w);
  const other = { ...approvedOf(w), code: "0ther" };
  assert.equal(refusalOf(w.cfg, request(other)), "code-mismatch");
  const codeMerged = { pr: PR, sha: MERGE_COMMIT };
  const premerge = approvedOf(w);
  const late = request(premerge, {
    state: approvedState(premerge, { codeMerged }),
  });
  assert.equal(refusalOf(w.cfg, late), "no-receipt");
  const reviewed = { ...approvedOf(w), code: MERGE_COMMIT };
  const ok = request(reviewed, {
    state: approvedState(reviewed, { codeMerged }),
  });
  const security = securityOf(resultOf(reviewed));
  fakeGh.reply([
    savedListing(approvedState(reviewed, { codeMerged, security })),
  ]);
  assert.equal(publishOf(w.cfg, ok).published, true);
});

test("publish fails on a codeMerged that isn't the PR's merge commit", () => {
  const w = world({ wiki: true });
  merged(w);
  const reviewed = { ...approvedOf(w), code: "0ther" };
  const req = request(reviewed, {
    state: approvedState(reviewed, { codeMerged: { pr: PR, sha: "0ther" } }),
  });
  assert.throws(() => publishOf(w.cfg, req), NOT_THE_MERGE_COMMIT);
});

test("publish of a change that lives only in the wiki needs no PR", () => {
  const w = world({ wiki: true });
  const approved = approvedOf(w);
  setCurrentRevision({ revision: approved, baseSha: "base", pr: null });
  const state = {
    ...approvedState(approved),
    pr: null,
    flows: { code: false, wiki: true },
  };
  const result = { ...approved, code: null };
  fakeGh.reply([savedListing({ ...state, security: securityOf(result) })]);
  const reply = publishOf(w.cfg, request(approved, { state }));
  assert.equal(reply.published, true);
  assert.equal(wikiRef(w, "master"), w.wikiSha);
});

test("publish with no approved wiki commits publishes nothing", () => {
  const w = world();
  const approved = { code: w.sha, wiki: null, inputs: "inputs-1" };
  setCurrentRevision({
    revision: { ...approved, code: MERGE_COMMIT },
    baseSha: "base",
    pr: {
      number: PR,
      state: "MERGED",
      mergeCommit: MERGE_COMMIT,
      headSha: w.sha,
    },
  });
  savedReceipt(approved);
  assert.deepEqual(publishOf(w.cfg, request(approved)), {
    published: true,
    sha: null,
    commits: [],
    alreadyPublished: false,
  });
});

test("publish refuses wiki commits the approval didn't include", () => {
  const w = world({ wiki: true });
  const approved = { code: w.sha, wiki: null, inputs: "inputs-1" };
  merged(w);
  savedReceipt(approved);
  const reply = publishOf(w.cfg, request(approved));
  assert.equal("reason" in reply && reply.reason, "stale");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("publish after the job's own merge refuses without the saved receipt, whatever the request says", () => {
  const w = world({ wiki: true });
  const approved = approvedOf(w);
  merged(w);
  fakeGh.reply([]);
  const claimed = request(approved, {
    state: approvedState(approved, {
      merged: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
    }),
  });
  assert.equal(refusalOf(w.cfg, claimed), "no-receipt");
  fakeGh.reply([
    savedListing({
      ...approvedState(approved, {
        merged: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
      }),
      stage: "review",
    }),
  ]);
  assert.equal(refusalOf(w.cfg, claimed), "no-receipt");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("publish refuses a saved receipt that isn't GitHub's merge of the approved revision", () => {
  const w = world({ wiki: true });
  const approved = approvedOf(w);
  merged(w);
  for (const receipt of [
    { code: "0ther" },
    { wiki: "0ther" },
    { inputs: "inputs-0" },
  ]) {
    savedReceipt(approved, receipt);
    assert.equal(refusalOf(w.cfg, request(approved)), "no-receipt");
  }
  const hardenedElsewhere = { ...approved, code: "0ther" };
  fakeGh.reply([
    savedListing(
      approvedState(approved, {
        merged: resultOf(approved),
        hardened: hardenedElsewhere,
        security: securityOf(resultOf(approved)),
      }),
    ),
  ]);
  assert.equal(refusalOf(w.cfg, request(approved)), "no-receipt");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});
