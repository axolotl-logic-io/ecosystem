// @ts-check
// Original hardening survives a claimed own-merge replay: the saved receipt
// binds GitHub's head and merge SHA separately, while only saved security of
// the exact result permits completion (src/ops/finish-guard.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

const root = fs.mkdtempSync("/tmp/issue-pipeline-own-merge-replay-");
const home = path.join(root, "home");
fs.mkdirSync(home);
Object.assign(
  process.env,
  Object.fromEntries([
    ["HOME", home],
    ["ISSUE_PIPELINE_ROOT", root],
  ]),
);
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const { ROOT, HOME } = await import("../src/pipeline-root.ts");
if (ROOT !== root || HOME !== home) {
  throw new Error("source imported outside the test's temporary root and home");
}
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
    flows: { code: true, wiki: true },
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
  for (const changed of [
    { ...fresh, pr: { ...pr, number: PR + 1 } },
    { ...fresh, pr: { ...pr, mergeCommit: "other" } },
  ]) {
    assert.throws(() => finish(saved, changed));
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
    assert.throws(() => finish(wrong));
  }
});

test("finish binds the saved merged wiki and inputs to authorization even if security cleared another result", () => {
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
    assert.throws(() => finish(wrong));
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
    assert.throws(() =>
      finish({
        ...saved,
        merged: changed,
        security: { revision: changed, commentId: 901, finding: null },
      }),
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
