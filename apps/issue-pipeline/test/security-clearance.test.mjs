// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import "./isolated-root-test-kit.mjs";

const TARGET_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MOVED_TARGET_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const { candidateRefusal, securityRefusal } = await import(
  "../src/security-clearance.ts"
);
const { configFixture } = await import("./config-fixtures.mjs");
const cfg = configFixture();
const { newIssueState } = await import("../src/state.ts");

const ISSUE = 7;
const COMMENT = 3;
const REVISION = { code: "candidate", inputs: "trusted-inputs" };
const TARGET = { repo: cfg.repo, branch: cfg.baseBranch, sha: TARGET_SHA };
const CLEAR = {
  revision: REVISION,
  phase: /** @type {const} */ ("candidate"),
  target: TARGET,
  commentId: COMMENT,
  finding: null,
};
const SAVED = {
  ...newIssueState(ISSUE),
  hardened: REVISION,
  hardenedTarget: TARGET,
  verifiedSha: REVISION.code,
  security: CLEAR,
};

test("only exact candidate hardening, checks and premerge Security clear the observed target", () => {
  assert.equal(candidateRefusal(SAVED, REVISION, cfg, TARGET.sha), undefined);
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
      security: { ...CLEAR, target: { ...TARGET, sha: MOVED_TARGET_SHA } },
    },
    {
      ...SAVED,
      security: { ...CLEAR, target: { ...TARGET, branch: "other" } },
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
    assert.notEqual(
      candidateRefusal(saved, REVISION, cfg, TARGET.sha),
      undefined,
    );
  }
  for (const revision of [
    { ...REVISION, code: "integrated" },
    { ...REVISION, inputs: "changed" },
  ]) {
    assert.notEqual(
      candidateRefusal(SAVED, revision, cfg, TARGET.sha),
      undefined,
    );
  }
});

test("historical merged-result clearance never supplies premerge permission", () => {
  const { phase: _phase, target: _target, ...historical } = CLEAR;
  const saved = { ...SAVED, security: historical };
  assert.notEqual(
    candidateRefusal(saved, REVISION, cfg, TARGET.sha),
    undefined,
  );
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

for (const target of [
  null,
  { ...TARGET, repo: "other/repository" },
  { ...TARGET, branch: "other" },
  { ...TARGET, sha: MOVED_TARGET_SHA },
]) {
  test(`a candidate receipt cannot replace retained hardening target: ${JSON.stringify(target)}`, () => {
    assert.notEqual(
      candidateRefusal(
        { ...SAVED, hardenedTarget: target },
        REVISION,
        cfg,
        TARGET.sha,
      ),
      undefined,
    );
    assert.notEqual(
      securityRefusal(
        {
          ...SAVED,
          hardenedTarget: target,
          merged: { ...REVISION, code: "result" },
        },
        { ...REVISION, code: "result" },
      ),
      undefined,
    );
  });
}

test("fresh configured repository, literal branch and advertised target must all match the receipt", () => {
  for (const changed of [
    { ...cfg, repo: "other/repository" },
    { ...cfg, baseBranch: "other" },
  ]) {
    assert.notEqual(
      candidateRefusal(SAVED, REVISION, changed, TARGET.sha),
      undefined,
    );
  }
  assert.notEqual(
    candidateRefusal(SAVED, REVISION, cfg, MOVED_TARGET_SHA),
    undefined,
  );
  const saved = {
    ...SAVED,
    security: { ...CLEAR, target: { ...TARGET, repo: "other/repository" } },
  };
  assert.notEqual(
    candidateRefusal(saved, REVISION, cfg, TARGET.sha),
    undefined,
  );
});
