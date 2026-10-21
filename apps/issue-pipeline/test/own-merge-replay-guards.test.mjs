// @ts-check
// Original hardening survives a claimed own-merge replay: the saved receipt
// binds GitHub's head and merge SHA separately, while only saved security of
// the exact result permits completion (src/ops/finish-guard.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { newIssueState, ISSUE_STATE } = await import("../src/state.ts");
const { finishGate } = await import("../src/ops/finish-guard.ts");

/** @typedef {import("../src/state.ts").IssueState} IssueState */
/** @typedef {import("../src/state.ts").Revision} Revision */
/** @typedef {import("../src/ops/merge-guard.ts").CurrentRevision} CurrentRevision */
const ISSUE = 7;
const PR = 50;
const HEAD = "approved-head";
const MERGE = "actual-merge";
const ORIGINAL = { code: "hardened-head", wiki: "old-wiki", inputs: "inputs" };
const APPROVED = { code: HEAD, wiki: "wiki", inputs: "inputs" };
const RESULT = { ...APPROVED, code: MERGE };
const BAD_CHAIN = /merge authorization/u;

/** @returns {IssueState} */
function receipt() {
  return {
    ...newIssueState(ISSUE),
    stage: "merge",
    pr: PR,
    flows: { code: true },
    hardened: ORIGINAL,
    integration: { reviewed: ORIGINAL, revision: APPROVED },
    codeMerged: { pr: PR, sha: MERGE },
    merged: RESULT,
    security: { revision: RESULT, commentId: 901, finding: null },
  };
}

/** @returns {CurrentRevision} */
function current() {
  return {
    revision: RESULT,
    baseSha: "base",
    pr: { number: PR, state: "MERGED", headSha: HEAD, mergeCommit: MERGE },
    codeMerged: { pr: PR, sha: MERGE },
    checkoutHead: MERGE,
    remoteHead: HEAD,
    issueFile: "issue.md",
  };
}

/** @param {IssueState} saved @param {CurrentRevision} [fresh] */
function finish(saved, fresh = current()) {
  return finishGate({ ...saved, stage: "done" }, fresh);
}

const MISSING_PR = /is missing from the current revision/u;
const MISMATCHED_RECEIPT = /the state's codeMerged .* is not PR/u;
const MISMATCHED_RESULT = /saved merged at other, which is not PR/u;

test("a claimed own merge reuses exact original authorization for finish without erasing provenance", () => {
  for (const saved of [
    receipt(),
    { ...receipt(), hardened: APPROVED, integration: null },
  ]) {
    const before = structuredClone(saved);
    assert.equal(finish(saved), undefined);
    assert.deepEqual(saved, before);
    assert.deepEqual(saved.hardened, before.hardened);
    assert.deepEqual(saved.codeMerged, { pr: PR, sha: MERGE });
  }
});

test("missing, malformed, stale or rejected saved security refuses the claimed own merge and its done replay", () => {
  for (const security of [
    null,
    { revision: RESULT, commentId: 0, finding: null },
    { revision: RESULT, commentId: 901 },
    { revision: APPROVED, commentId: 901, finding: null },
    { revision: { ...RESULT, wiki: "other" }, commentId: 901, finding: null },
    { revision: { ...RESULT, inputs: "other" }, commentId: 901, finding: null },
    {
      revision: RESULT,
      commentId: 901,
      finding: { category: "user-harm", reason: "unsafe" },
    },
  ]) {
    const saved = ISSUE_STATE.parse({ ...receipt(), security });
    assert.equal(finish(saved)?.reason, "security");
  }
});

test("GitHub head, PR and merge commit and both saved and requested code provenance are independently checked", () => {
  const saved = receipt();
  const fresh = current();
  const { pr } = fresh;
  assert.ok(pr);
  for (const { changed, refusal } of [
    {
      changed: { ...fresh, pr: { ...pr, number: PR + 1 } },
      refusal: MISSING_PR,
    },
    {
      changed: { ...fresh, pr: { ...pr, mergeCommit: "other" } },
      refusal: MISMATCHED_RECEIPT,
    },
  ]) {
    assert.throws(() => finish(saved, changed), refusal);
  }
  assert.throws(
    () => finish(saved, { ...fresh, pr: { ...pr, headSha: "other" } }),
    BAD_CHAIN,
  );
  for (const codeMerged of [
    { pr: PR + 1, sha: MERGE },
    { pr: PR, sha: "other" },
  ]) {
    const wrong = { ...saved, codeMerged };
    assert.throws(() => finish(wrong), MISMATCHED_RECEIPT);
  }
});

test("finish binds the saved legacy wiki head and inputs to authorization even if security cleared another result", () => {
  const saved = receipt();
  for (const changed of [
    { ...RESULT, wiki: "other" },
    { ...RESULT, inputs: "other" },
    { ...RESULT, code: "other" },
  ]) {
    const wrong = {
      ...saved,
      merged: changed,
      security: { revision: changed, commentId: 901, finding: null },
    };
    let refusal = BAD_CHAIN;
    if (changed.code === "other") {
      refusal = MISMATCHED_RESULT;
    }
    assert.throws(() => finish(wrong), refusal);
  }
});

test("an independently hardened merge-SHA authorization remains valid", () => {
  const saved = {
    ...receipt(),
    hardened: RESULT,
    integration: null,
    merged: null,
  };
  assert.equal(finish({ ...saved, merged: RESULT }), undefined);
  for (const changed of [
    { ...RESULT, wiki: "other" },
    { ...RESULT, inputs: "other" },
  ]) {
    assert.throws(
      () =>
        finish({
          ...saved,
          merged: changed,
          security: { revision: changed, commentId: 901, finding: null },
        }),
      BAD_CHAIN,
    );
  }
});

test("a merge-SHA authorization without confirmed codeMerged cannot replace an own-merge receipt", () => {
  const saved = {
    ...receipt(),
    hardened: RESULT,
    integration: null,
    codeMerged: null,
  };
  assert.throws(() => finish(saved), BAD_CHAIN);
});
