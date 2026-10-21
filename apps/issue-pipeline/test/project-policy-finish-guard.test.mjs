// @ts-check
// Fresh result-policy clearance and original historical authority are independent gates.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODE_MERGED,
  MERGED_PR,
  LEGACY_UNBOUND_MERGED_REVISION as MERGED_REVISION,
  legacyUnboundMerging as merging,
} from "./roles/merge/merge-role-test-kit.mjs";
import {
  COMMENT_ID,
  MOVED,
  NEW_INPUTS,
  LEGACY_UNBOUND_REVISION as REVISION,
} from "./roles/reviewer-and-merge-role-test-kit.mjs";

const { policyRevision } = await import("../src/project-policy.ts");
const { finishGate } = await import("../src/ops/finish-guard.ts");
const { ownMergeResultObservation } = await import("../src/ops/merge-guard.ts");
const POLICY = policyRevision(merging().ctx.cfg).policy;
const RESULT = { ...MERGED_REVISION, policy: POLICY };
const BAD_CHAIN = /merge authorization/u;
const PRIVATE_DATA = /private data is exposed/u;
/** @type {NonNullable<import("../src/ops/merge-guard.ts").CurrentRevision["pr"]>} */
const CONFIRMED_PR = { ...MERGED_PR, state: "MERGED" };

/** @returns {import("../src/state.ts").IssueState} */
function completion() {
  return {
    ...merging().ctx.state,
    ...CODE_MERGED,
    stage: "done",
    merged: MERGED_REVISION,
    security: { revision: RESULT, commentId: COMMENT_ID, finding: null },
  };
}

/** @returns {import("../src/ops/merge-guard.ts").CurrentRevision} */
function observed() {
  return {
    revision: RESULT,
    baseSha: MOVED,
    pr: CONFIRMED_PR,
    codeMerged: CODE_MERGED.codeMerged,
    checkoutHead: MERGED_REVISION.code,
    remoteHead: REVISION.code,
    issueFile: "issue.md",
  };
}

test("finish accepts a new current-policy result observation while preserving unbound original receipt", () => {
  const saved = completion();
  const before = structuredClone(saved);
  assert.deepEqual(ownMergeResultObservation(saved, observed()), RESULT);
  assert.equal(finishGate(saved, observed()), undefined);
  assert.deepEqual(saved, before);
  assert.deepEqual(saved.merged, MERGED_REVISION);
  assert.deepEqual(saved.hardened, REVISION);
});

test("an old result clearance does not complete work under a fresh effective policy", () => {
  const saved = completion();
  saved.security = {
    revision: MERGED_REVISION,
    commentId: COMMENT_ID,
    finding: null,
  };
  assert.equal(finishGate(saved, observed())?.reason, "security");
});

test("a changed checking policy cannot erase a historical same-content Security finding", () => {
  const saved = completion();
  saved.security = {
    revision: MERGED_REVISION,
    commentId: COMMENT_ID,
    finding: { category: "rights", reason: "private data is exposed" },
  };
  const refusal = finishGate(saved, observed());
  assert.equal(refusal?.reason, "security");
  assert.match(refusal?.detail ?? "", PRIVATE_DATA);
});

test("an independent postmerge authorization cannot pretend to be an old own-merge receipt", () => {
  const saved = {
    ...completion(),
    hardened: MERGED_REVISION,
    integration: null,
  };
  assert.equal(ownMergeResultObservation(saved, observed()), null);
  assert.equal(finishGate(saved, observed())?.reason, "security");
});

test("rewriting the original receipt with today's policy breaks the original authorization chain", () => {
  const saved = { ...completion(), merged: RESULT };
  assert.equal(ownMergeResultObservation(saved, observed()), null);
  assert.throws(() => finishGate(saved, observed()), BAD_CHAIN);
});

test("wrong original PR, head and merge metadata retain the canonical refusal", () => {
  const saved = completion();
  const at = observed();
  for (const pr of [
    { ...CONFIRMED_PR, number: CONFIRMED_PR.number + 1 },
    { ...CONFIRMED_PR, headSha: MOVED },
    { ...CONFIRMED_PR, mergeCommit: MOVED },
  ]) {
    assert.equal(ownMergeResultObservation(saved, { ...at, pr }), null);
    assert.throws(() => finishGate(saved, { ...at, pr }));
  }
});

test("wrong code, inputs, legacy wiki or current policy cannot clear another result", () => {
  const saved = completion();
  const at = observed();
  for (const revision of [
    { ...RESULT, code: MOVED },
    { ...RESULT, inputs: NEW_INPUTS },
    { ...RESULT, wiki: MOVED },
    { ...RESULT, policy: "f".repeat(POLICY.length) },
  ]) {
    assert.notEqual(finishGate(saved, { ...at, revision }), undefined);
  }
});

test("unproven or mismatched saved provenance cannot authorize a current-policy result", () => {
  const at = observed();
  for (const saved of [
    { ...completion(), merged: null },
    { ...completion(), hardened: null },
    {
      ...completion(),
      codeMerged: { pr: MERGED_PR.number + 1, sha: MERGED_REVISION.code },
    },
    { ...completion(), merged: { ...MERGED_REVISION, wiki: MOVED } },
  ]) {
    assert.equal(ownMergeResultObservation(saved, at), null);
    assert.throws(() => finishGate(saved, at));
  }
});
