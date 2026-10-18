// @ts-check
// The security review's hold on completion (src/security-clearance.ts, via
// the publish and finish-wiki ops): after a merge into the base, nothing is
// published and the issue doesn't complete unless the issue's saved state
// holds a security review that found nothing at exactly the merged result:
// GitHub's merge commit (no code for a change with no PR), the wiki head and
// the trusted inputs. A missing review, a finding, or a review of any other
// revision (the pre-merge head included) refuses as `security`, changing
// nothing, on a first completion and on a replay alike.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import {
  approvedState,
  fakeGh,
  MERGE_COMMIT,
  PR,
  publishOf,
  refusalOf,
  savedListing,
  securityOf,
  wikiRef,
  world,
  writes,
} from "./ops-publish-test-kit.mjs";

const { finishWiki } = await import("../src/ops/finish.ts");

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @typedef {import("../src/state.ts").Revision} Revision */
/** @typedef {import("../src/state.ts").Security} Security */

const DONE_WITH_CODE_BUT_NO_PR = /done with code .* but no PR/u;
const NOT_THE_AUTHORIZED_HEAD =
  /merge authorization .* is not .*, which PR #50 merged/u;
/** @type {NonNullable<Security["finding"]>} */
const FINDING = { category: "user-harm", reason: "leaks the users' tokens" };

/** @param {World} w @returns {{ approved: Revision, result: Revision }} */
function chainOf(w) {
  return {
    approved: { code: w.sha, wiki: w.wikiSha, inputs: "inputs-1" },
    result: { code: MERGE_COMMIT, wiki: w.wikiSha, inputs: "inputs-1" },
  };
}

// GitHub says PR #50 merged head w.sha as MERGE_COMMIT; inputs unchanged.
/** @param {World} w @returns {void} */
function merged(w) {
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

// Security reviews that don't clear `result`: none, one with a finding, and
// ones of another code head, wiki head or trusted inputs.
/** @param {World} w @param {Revision} result @returns {(Security | null)[]} */
function unclearing(w, result) {
  return [
    null,
    securityOf(result, FINDING),
    securityOf({ ...result, code: w.sha }),
    securityOf({ ...result, wiki: null }),
    securityOf({ ...result, inputs: "inputs-0" }),
  ];
}

test("publish refuses a merged result its saved security review doesn't clear, whatever the request says", () => {
  const w = world({ wiki: true });
  const { approved, result } = chainOf(w);
  merged(w);
  for (const security of unclearing(w, result)) {
    const saved = approvedState(approved, { merged: result, security });
    fakeGh.reply([savedListing(saved)]);
    const claimed = {
      number: 7,
      state: { ...saved, security: securityOf(result) },
      expectedWiki: approved.wiki,
      revision: approved,
    };
    assert.equal(refusalOf(w.cfg, claimed), "security");
  }
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

// A done completion replayed, as on a reopened done issue: the claim
// recorded GitHub's merge (codeMerged), and the revision is the merged one.
test("a replayed publish of a done completion refuses as security unless its review cleared the merged result", () => {
  const w = world({ wiki: true });
  const { result } = chainOf(w);
  merged(w);
  const codeMerged = { pr: PR, sha: MERGE_COMMIT };
  for (const security of unclearing(w, result)) {
    const done = {
      ...approvedState(result),
      stage: "done",
      codeMerged,
      merged: result,
      security,
    };
    fakeGh.reply([savedListing(done)]);
    const replay = {
      number: 7,
      state: { ...done, security: securityOf(result) },
      expectedWiki: result.wiki,
      revision: result,
    };
    assert.equal(refusalOf(w.cfg, replay), "security");
    assert.deepEqual(writes(), []);
  }
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
  const cleared = {
    ...approvedState(result),
    stage: "done",
    codeMerged,
    merged: result,
    security: securityOf(result),
  };
  fakeGh.reply([savedListing(cleared)]);
  const request = { number: 7, state: cleared, expectedWiki: result.wiki };
  assert.ok(publishOf(w.cfg, { ...request, revision: result }).published);
  assert.equal(wikiRef(w, "master"), w.wikiSha);
});

test("publish of a change that lives only in the wiki needs a security review of no code", () => {
  const w = world({ wiki: true });
  const { approved } = chainOf(w);
  setCurrentRevision({ revision: approved, baseSha: "base", pr: null });
  const state = {
    ...approvedState(approved),
    pr: null,
    flows: { code: false, wiki: true },
  };
  fakeGh.reply([savedListing({ ...state, security: securityOf(approved) })]);
  const req = {
    number: 7,
    state,
    expectedWiki: approved.wiki,
    revision: approved,
  };
  assert.equal(refusalOf(w.cfg, req), "security");
  assert.equal(wikiRef(w, "master") === w.wikiSha, false);
});

test("finish-wiki refuses a saved completion its security review doesn't clear, changing nothing", () => {
  const w = world({ wiki: true });
  const { approved, result } = chainOf(w);
  merged(w);
  for (const security of unclearing(w, result)) {
    const saved = {
      ...approvedState(approved),
      stage: "done",
      merged: result,
      security,
    };
    fakeGh.reply([savedListing(saved)]);
    const reply = finishWiki(w.cfg, { number: 7, state: saved });
    assert.equal("reason" in reply && reply.reason, "security");
    assert.deepEqual(writes(), []);
  }
});

test("finish-wiki fails on a change with no PR saved as merging code", () => {
  const w = world({ wiki: true });
  const { approved } = chainOf(w);
  setCurrentRevision({ revision: approved, baseSha: "base", pr: null });
  const saved = {
    ...approvedState(approved),
    stage: "done",
    pr: null,
    flows: { code: false, wiki: true },
    merged: approved,
    security: securityOf(approved),
  };
  fakeGh.reply([savedListing(saved)]);
  assert.throws(
    () => finishWiki(w.cfg, { number: 7 }),
    DONE_WITH_CODE_BUT_NO_PR,
  );
  assert.deepEqual(writes(), []);
});

test("finish-wiki fails on a completion whose merge authorization isn't the head GitHub merged, changing nothing", () => {
  const w = world({ wiki: true });
  const { approved, result } = chainOf(w);
  merged(w);
  for (const hardened of [null, { ...approved, code: "0ther" }]) {
    const saved = {
      ...approvedState(approved, { hardened }),
      stage: "done",
      merged: result,
      security: securityOf(result),
    };
    fakeGh.reply([savedListing(saved)]);
    assert.throws(
      () => finishWiki(w.cfg, { number: 7 }),
      NOT_THE_AUTHORIZED_HEAD,
    );
    assert.deepEqual(writes(), []);
  }
});
