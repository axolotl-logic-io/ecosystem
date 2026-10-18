// @ts-check
// The publish op (src/ops/publish.ts, src/wiki-publication.ts): after fresh
// source and merged-PR gates it fast-forwards the wiki to exactly the
// approved wiki head, never rebasing, and changes nothing on GitHub.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  MERGE_COMMIT,
  moveWiki,
  PR,
  savedListing,
  sh,
  wikiRef,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { publishOps } = await import("../src/ops/publish.ts");
const publish = publishOps["publish"];
if (publish === undefined) {
  throw new Error("publish is not an op");
}

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
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

// The job's own merge saved its partial receipt: still at stage merge, its
// merged naming GitHub's merge commit with the approved wiki and inputs.
/** @param {Revision} approved @param {object} [receipt] @returns {void} */
function savedReceipt(approved, receipt = {}) {
  const merged = {
    code: MERGE_COMMIT,
    wiki: approved.wiki,
    inputs: approved.inputs,
    ...receipt,
  };
  fakeGh.reply([savedListing(approvedState(approved, { merged }))]);
}

/** @param {World} w @param {Revision} approved @param {object} [extra] @returns {object} */
function request(w, approved, extra = {}) {
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
  const reply = publish(w.cfg, request(w, approvedOf(w)));
  const short = String(w.wikiSha).slice(0, 12);
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
  publish(w.cfg, request(w, approvedOf(w)));
  const again = publish(w.cfg, request(w, approvedOf(w)));
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
  const reply = publish(w.cfg, request(w, approvedOf(w)));
  assert.equal(reply.published, false);
  assert.equal("reason" in reply && reply.reason, "wiki-behind");
  assert.equal(wikiRef(w, "master"), moved);
  assert.equal(sh(`git -C ${w.wikiDir} rev-parse HEAD`), w.wikiSha);
});

test("publish refuses changed trusted inputs, an open PR and an unapproved revision", () => {
  const w = world({ wiki: true });
  const approved = approvedOf(w);
  merged(w, { inputs: "inputs-2" });
  assert.equal(publish(w.cfg, request(w, approved)).reason, "stale");
  merged(w, { state: "OPEN" });
  assert.equal(publish(w.cfg, request(w, approved)).reason, "not-merged");
  merged(w);
  const unapproved = request(w, approved, {
    state: { ...approvedState(approved), review: { verdict: "changes" } },
  });
  assert.equal(publish(w.cfg, unapproved).reason, "unapproved");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("before codeMerged only the head GitHub merged is the approved code; after, only the merge commit", () => {
  const w = world({ wiki: true });
  merged(w);
  const other = { ...approvedOf(w), code: "0ther" };
  assert.equal(publish(w.cfg, request(w, other)).reason, "code-mismatch");
  const codeMerged = { pr: PR, sha: MERGE_COMMIT };
  const premerge = approvedOf(w);
  const late = request(w, premerge, {
    state: approvedState(premerge, { codeMerged }),
  });
  assert.equal(publish(w.cfg, late).reason, "code-mismatch");
  const reviewed = { ...approvedOf(w), code: MERGE_COMMIT };
  const ok = request(w, reviewed, {
    state: approvedState(reviewed, { codeMerged }),
  });
  assert.equal(publish(w.cfg, ok).published, true);
});

test("publish fails on a codeMerged that isn't the PR's merge commit", () => {
  const w = world({ wiki: true });
  merged(w);
  const reviewed = { ...approvedOf(w), code: "0ther" };
  const req = request(w, reviewed, {
    state: approvedState(reviewed, { codeMerged: { pr: PR, sha: "0ther" } }),
  });
  assert.throws(() => publish(w.cfg, req), /not PR #50's merge commit/u);
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
  const reply = publish(w.cfg, request(w, approved, { state }));
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
  assert.deepEqual(publish(w.cfg, request(w, approved)), {
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
  const reply = publish(w.cfg, request(w, approved));
  assert.equal("reason" in reply && reply.reason, "stale");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("publish after the job's own merge refuses without the saved receipt, whatever the request says", () => {
  const w = world({ wiki: true });
  const approved = approvedOf(w);
  merged(w);
  fakeGh.reply([]);
  const claimed = request(w, approved, {
    state: approvedState(approved, {
      merged: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
    }),
  });
  assert.equal(publish(w.cfg, claimed).reason, "no-receipt");
  fakeGh.reply([
    savedListing({
      ...approvedState(approved, {
        merged: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
      }),
      stage: "review",
    }),
  ]);
  assert.equal(publish(w.cfg, claimed).reason, "no-receipt");
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
    assert.equal(publish(w.cfg, request(w, approved)).reason, "no-receipt");
  }
  const reviewedElsewhere = { ...approved, code: "0ther" };
  fakeGh.reply([
    savedListing({
      ...approvedState(approved, {
        merged: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
      }),
      review: {
        round: 0,
        verdict: "approve",
        commentId: null,
        findings: [],
        revision: reviewedElsewhere,
      },
    }),
  ]);
  assert.equal(publish(w.cfg, request(w, approved)).reason, "no-receipt");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});
