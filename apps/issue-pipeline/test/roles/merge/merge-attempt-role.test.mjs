// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE,
  BRANCH,
  PR,
  REPO,
  world,
} from "../../explicit-target-world-test-kit.mjs";
import {
  codeWrites,
  context,
  current,
  NO_FINDING,
  names,
  ownState,
  postmergeOps,
  result,
  saves,
} from "./explicit-target-role-test-kit.mjs";

const { mergeRole } = await import("../../../src/roles/merge/merge.ts");
/** @param {import("../../explicit-target-world-test-kit.mjs").World} w @param {string | null} [response] @returns {import("../../../src/state.ts").MergeAttempt} */
function attemptOf(w, response = w.merged) {
  return {
    repo: REPO,
    pr: PR,
    target: BASE,
    branch: BRANCH,
    authorized: w.revision,
    hardened: w.revision,
    integration: null,
    result: response,
    reads: 1,
  };
}

test("saved successful FF response reconciles before ordinary approval or writers, then confirms M read-only and reuses premerge security", async () => {
  const w = world({ fastForward: true });
  const security = {
    revision: w.revision,
    phase: /** @type {const} */ ("candidate"),
    target: w.state.hardenedTarget,
    commentId: PR,
    finding: null,
  };
  const run = context(w, {
    state: { mergeAttempt: attemptOf(w), merged: null, security },
    ops: {
      finish: postmergeOps(w).finish,
      "confirm-merged": [{ confirmed: true, headSha: w.merged }],
      "reconcile-merge": [
        { merged: true, mergeCommit: w.merged, headSha: w.head },
      ],
      "current-revision": [current(w, true), current(w, true)],
    },
  });
  const end = await mergeRole(run.ctx);
  assert.equal(end.kind, "next");
  assert.equal(names(run.calls)[0], "reconcile-merge");
  assert.equal(saves(run.calls)[0]?.merged?.code, w.merged);
  assert.deepEqual(saves(run.calls)[0]?.hardened, w.revision);
  assert.ok(
    names(run.calls).indexOf("confirm-merged") <
      names(run.calls).indexOf("finish"),
  );
  assert.equal(names(run.calls).includes("merge"), false);
  assert.equal(names(run.calls).includes("verify"), false);
  assert.equal(names(run.calls).includes("session"), false);
  assert.deepEqual(saves(run.calls).at(-1)?.security, security);
  assert.deepEqual(codeWrites(run.calls), []);
});

test("saved successful response without premerge security stops after read-only confirmation, never reviewing M", async () => {
  const w = world({ fastForward: true });
  const run = context(w, {
    state: { mergeAttempt: attemptOf(w), merged: null, security: null },
    ops: {
      "confirm-merged": [{ confirmed: true, headSha: w.merged }],
      "reconcile-merge": [
        { merged: true, mergeCommit: w.merged, headSha: w.head },
      ],
      "current-revision": [current(w, true), current(w, true)],
    },
    sessions: [NO_FINDING],
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.state.merged?.code, w.merged);
  assert.equal(end.state.security, null);
  for (const name of ["verify", "prepare-review", "session", "finish"]) {
    assert.equal(names(run.calls).includes(name), false, name);
  }
  assert.deepEqual(codeWrites(run.calls), []);
});

for (const reply of [
  { merged: false, reason: "bounded recovery; no another POST or writer" },
  { merged: true, byHand: true },
]) {
  test(`unconfirmed/external evidence cannot enter own processing or a writer: ${JSON.stringify(reply)}`, async () => {
    const w = world();
    const run = context(w, {
      state: { mergeAttempt: attemptOf(w, null), merged: null },
      ops: {
        "reconcile-merge": [
          { ...reply, mergeCommit: w.merged, headSha: w.head },
        ],
      },
    });
    const end = await mergeRole(run.ctx);
    assert.equal(end.kind, "stop");
    assert.deepEqual(names(run.calls), ["reconcile-merge"]);
    assert.deepEqual(saves(run.calls), []);
    assert.deepEqual(codeWrites(run.calls), []);
  });
}

test("durable exact security rejection with attempted/merged evidence never rerolls after lifting the stop", async () => {
  const w = world();
  const rejection = {
    revision: result(w),
    commentId: PR,
    finding: { category: /** @type {const} */ ("rights"), reason: "unsafe" },
  };
  const run = context(w, {
    state: { ...ownState(w), mergeAttempt: attemptOf(w), security: rejection },
    ops: { "current-revision": [current(w, true)] },
  });
  const end = await mergeRole(run.ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "rights");
  assert.equal(end.state.merged?.code, w.merged);
  assert.deepEqual(end.state.security, rejection);
  assert.deepEqual(names(run.calls), ["current-revision"]);
  assert.deepEqual(codeWrites(run.calls), []);
});
