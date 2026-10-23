// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endCode,
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  COMMENT_ID,
  cfg,
  current,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  REVISION,
  sha,
} from "../reviewer-and-merge-role-test-kit.mjs";
import { AFTER_MERGE, finding, merging } from "./merge-role-test-kit.mjs";

const CLEAR = {
  revision: REVISION,
  phase: /** @type {const} */ ("candidate"),
  target: { repo: cfg.repo, branch: cfg.baseBranch, sha: current().baseSha },
  commentId: COMMENT_ID,
  finding: null,
};

test("target movement during Security discards clearance and has zero merge effects", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), { ...current(), baseSha: MOVED }] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.security, null);
  assert.equal(state.merged, null);
  assert.ok(savesOf(calls).every(({ security }) => security === null));
  for (const mutation of ["merge", "push", "finish", "ready-pr"]) {
    assert.ok(!opNames(calls).includes(mutation));
  }
});

test("a finding returned while only the target moves is saved and cannot reroll after fresh target hardening", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), { ...current(), baseSha: MOVED }] },
    sessions: [finding("rights")],
  });
  const end = await mergeRole(ctx);
  assert.equal(endCode(end), "rights");
  const rejected = stateOf(end, "stop");
  assert.deepEqual(rejected.security, {
    ...CLEAR,
    finding: {
      category: "rights",
      reason: "src/chat.ts:12 drops the owner scope",
    },
  });
  assert.deepEqual(savesOf(calls).at(-1)?.security, rejected.security);
  assert.equal(rejected.merged, null);
  assert.equal(sessionsOf(calls).length, 1);
  assert.ok(sessionsOf(calls).every((spec) => spec.commits === false));
  assert.ok(!opNames(calls).includes("merge"));
  const retry = merging({
    state: {
      ...rejected,
      hardened: REVISION,
      hardenedTarget: { ...CLEAR.target, sha: MOVED },
    },
    ops: { "current-revision": [{ ...current(), baseSha: MOVED }] },
    sessions: [],
  });
  const retried = await mergeRole(retry.ctx);
  assert.equal(endCode(retried), "rights");
  const stopped = stateOf(retried, "stop");
  assert.deepEqual(stopped.security, rejected.security);
  assert.deepEqual(opNames(retry.calls), ["current-revision"]);
  assert.equal(sessionsOf(retry.calls).length, 0);
});

test("a returned finding with changed code still discards the obsolete subject", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ code: MOVED })] },
    sessions: [finding("rights")],
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.security, null);
  assert.ok(savesOf(calls).every((saved) => saved.security === null));
  assert.ok(!opNames(calls).includes("merge"));
});

test("a returned finding with changed inputs still returns to requirements review", async () => {
  const { ctx, calls } = merging({
    ops: { "current-revision": [current(), current({ inputs: NEW_INPUTS })] },
    sessions: [finding("rights")],
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "author");
  assert.equal(state.security, null);
  assert.ok(savesOf(calls).every((saved) => saved.security === null));
  assert.ok(!opNames(calls).includes("merge"));
});

test("exact saved candidate clearance permits only one merge and no duplicate postmerge model pass", async () => {
  const { ctx, calls } = merging({
    state: { security: CLEAR },
    sessions: [],
    ops: { "current-revision": [current(), current(), AFTER_MERGE] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.deepEqual(state.security, CLEAR);
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(opNames(calls).filter((name) => name === "merge").length, 1);
  assert.ok(!opNames(calls).includes("prepare-review"));
  assert.ok(
    !opNames(calls).includes("verify", opNames(calls).indexOf("merge")),
  );
  assert.deepEqual(firstPayload(calls, "confirm-merged"), {
    number: ctx.issue,
    codeMerged: { pr: ctx.state.pr, sha: state.merged?.code },
  });
});

test("an old postmerge receipt naming the candidate never substitutes for premerge Security", async () => {
  const { phase: _phase, target: _target, ...historical } = CLEAR;
  const { ctx, calls } = merging({ state: { security: historical } });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.equal(sessionsOf(calls).length, 1);
  assert.deepEqual(state.security?.target, CLEAR.target);
  assert.deepEqual(state.security?.revision, REVISION);
});

for (const target of [
  null,
  { ...CLEAR.target, repo: "other/repository" },
  { ...CLEAR.target, branch: "other" },
  { ...CLEAR.target, sha: MOVED },
]) {
  test(`unknown or stale retained target returns to hardening before any checks or session: ${JSON.stringify(target)}`, async () => {
    const { ctx, calls } = merging({
      state: { hardenedTarget: target, security: CLEAR },
      sessions: [],
    });
    const state = stateOf(await mergeRole(ctx), "next");
    assert.equal(state.stage, "review");
    assert.equal(state.hardened, null);
    assert.deepEqual(state.security, CLEAR);
    assert.deepEqual(opNames(calls), ["current-revision"]);
    assert.equal(sessionsOf(calls).length, 0);
    assert.equal(savesOf(calls).length, 0);
  });
}

test("target movement after saved Security reuse returns to hardening without a merge", async () => {
  const { ctx, calls } = merging({
    state: { security: CLEAR },
    sessions: [],
    ops: { "current-revision": [current(), { ...current(), baseSha: MOVED }] },
  });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "review");
  assert.deepEqual(state.security, CLEAR);
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(!opNames(calls).includes("merge"));
});

test("a new target cannot reroll rejection of unchanged candidate content", async () => {
  const rejection = {
    ...CLEAR,
    finding: { category: /** @type {const} */ ("rights"), reason: "unsafe" },
  };
  const { ctx, calls } = merging({
    state: { security: rejection },
    ops: { "current-revision": [{ ...current(), baseSha: MOVED }] },
    sessions: [],
  });
  const end = await mergeRole(ctx);
  assert.equal(end.kind, "stop");
  if (end.kind !== "stop") {
    throw new Error("rejected candidate unexpectedly continued");
  }
  assert.equal(end.code, "rights");
  assert.deepEqual(end.state.security, rejection);
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
});

const { securityReviewed } = await import(
  "../../../src/roles/merge/security.ts"
);
for (const evidence of [
  { codeMerged: { pr: 90, sha: sha("e") } },
  { merged: { ...REVISION, code: sha("e") } },
  {
    mergeAttempt: {
      repo: cfg.repo,
      pr: 90,
      target: cfg.baseBranch,
      branch: "agent/issue-7",
      authorized: REVISION,
      hardened: REVISION,
      integration: null,
      result: null,
      reads: 0,
    },
  },
]) {
  test(`candidate review refuses merged or uncertain provenance without preparation or a writer: ${JSON.stringify(evidence)}`, async () => {
    const { ctx, calls } = merging({ state: evidence, sessions: [] });
    const result = await securityReviewed(ctx, ctx.state, {
      revision: REVISION,
      target: CLEAR.target,
      codeMerged: null,
      still: () => true,
    });
    assert.equal(result.ok, false);
    if (result.ok) {
      throw new Error("candidate unexpectedly cleared");
    }
    assert.equal(result.end.kind, "stop");
    assert.deepEqual(calls, []);
  });
}
