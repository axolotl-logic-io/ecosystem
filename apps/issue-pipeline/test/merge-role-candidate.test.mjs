// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { AFTER_MERGE, merging } from "./merge-role-test-kit.mjs";
import {
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  cfg,
  current,
  MOVED,
  mergeRole,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const CLEAR = {
  revision: REVISION,
  candidate: { target: cfg.baseBranch, baseSha: current().baseSha },
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
  assert.deepEqual(firstPayload(calls, "verify"), {
    number: ctx.issue,
    codeMerged: { pr: ctx.state.pr, sha: state.merged?.code },
  });
});

test("an old postmerge receipt naming the candidate never substitutes for premerge Security", async () => {
  const { candidate: _candidate, ...historical } = CLEAR;
  const { ctx, calls } = merging({ state: { security: historical } });
  const state = stateOf(await mergeRole(ctx), "next");
  assert.equal(state.stage, "done");
  assert.equal(sessionsOf(calls).length, 1);
  assert.deepEqual(state.security?.candidate, CLEAR.candidate);
  assert.deepEqual(state.security?.revision, REVISION);
});
