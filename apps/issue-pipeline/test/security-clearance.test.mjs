// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const { candidateRefusal, securityRefusal } = await import(
  "../src/security-clearance.ts"
);
const { newIssueState } = await import("../src/state.ts");

const ISSUE = 7;
const COMMENT = 3;
const REVISION = { code: "candidate", inputs: "trusted-inputs" };
const CANDIDATE = { target: "main", baseSha: "target-before" };
const CLEAR = {
  revision: REVISION,
  candidate: CANDIDATE,
  commentId: COMMENT,
  finding: null,
};
const SAVED = {
  ...newIssueState(ISSUE),
  hardened: REVISION,
  verifiedSha: REVISION.code,
  security: CLEAR,
};

test("only exact candidate hardening, checks and premerge Security clear the observed target", () => {
  assert.equal(candidateRefusal(SAVED, REVISION, CANDIDATE), undefined);
  for (const saved of [
    { ...SAVED, hardened: null },
    { ...SAVED, verifiedSha: null },
    { ...SAVED, security: null },
    {
      ...SAVED,
      security: { ...CLEAR, revision: { ...REVISION, code: "other" } },
    },
    {
      ...SAVED,
      security: { ...CLEAR, revision: { ...REVISION, inputs: "old" } },
    },
    {
      ...SAVED,
      security: { ...CLEAR, candidate: { ...CANDIDATE, baseSha: "old" } },
    },
    {
      ...SAVED,
      security: { ...CLEAR, candidate: { ...CANDIDATE, target: "other" } },
    },
    {
      ...SAVED,
      security: {
        ...CLEAR,
        finding: {
          category: /** @type {const} */ ("rights"),
          reason: "exports private data",
        },
      },
    },
  ]) {
    assert.notEqual(candidateRefusal(saved, REVISION, CANDIDATE), undefined);
  }
  for (const revision of [
    { ...REVISION, code: "integrated" },
    { ...REVISION, inputs: "changed" },
  ]) {
    assert.notEqual(candidateRefusal(SAVED, revision, CANDIDATE), undefined);
  }
});

test("historical merged-result clearance never supplies premerge permission", () => {
  const { candidate: _candidate, ...historical } = CLEAR;
  const saved = { ...SAVED, security: historical };
  assert.notEqual(candidateRefusal(saved, REVISION, CANDIDATE), undefined);
  assert.equal(securityRefusal(saved, REVISION), undefined);
  assert.notEqual(
    securityRefusal(saved, { ...REVISION, code: "other" }),
    undefined,
  );
});

test("candidate clearance reaches completion only through the saved own result and original authorization", () => {
  const result = { ...REVISION, code: "merged-result" };
  assert.notEqual(securityRefusal(SAVED, result), undefined);
  const saved = { ...SAVED, merged: result };
  assert.equal(securityRefusal(saved, result), undefined);
  assert.notEqual(
    securityRefusal({ ...saved, hardened: null }, result),
    undefined,
  );
  assert.notEqual(
    securityRefusal(saved, { ...result, inputs: "changed" }),
    undefined,
  );
});
