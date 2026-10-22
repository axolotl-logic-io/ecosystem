// @ts-check
// An interrupted own merge resumes from its saved receipt and original
// authorization, never a fabricated hardening of the merge SHA. GitHub
// independently confirms both the authorized PR head and the merge commit.
// Missing Security is never reviewed after the merge (#185).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  COMMENT_ID,
  current,
  gherkinComment,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  PR,
  REVISION,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_MERGE,
  CODE_MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";

const RECEIPT = { ...CODE_MERGED, merged: MERGED_REVISION };
const CLEARED = {
  revision: MERGED_REVISION,
  commentId: COMMENT_ID,
  finding: null,
};
const FORBIDDEN = ["merge", "push", "sync-base", "ready-pr"];

for (const codeMerged of [null, CODE_MERGED.codeMerged]) {
  test(`an interrupted own merge missing security with codeMerged ${String(codeMerged?.sha ?? null)} stops, with no postmerge review, writer or second merge`, async () => {
    // A saved pre-upgrade own merge has no premerge receipt. Its missing
    // historical Security review is not run retrospectively; the merged
    // receipt is retained for read-only reconciliation.
    const { ctx, calls } = merging({
      state: { ...RECEIPT, codeMerged },
      ops: {
        "current-revision": [AFTER_MERGE, AFTER_MERGE],
        "prepare-review": [PREPARED_MERGED],
      },
    });
    const stopped = stateOf(await mergeRole(ctx), "stop");
    assert.notEqual(stopped.stage, "done");
    assert.deepEqual(stopped.hardened, REVISION);
    assert.deepEqual(stopped.merged, MERGED_REVISION);
    assert.deepEqual(stopped.codeMerged, codeMerged);
    assert.equal(stopped.security, null);
    assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
    assert.equal(sessionsOf(calls).length, 0);
    for (const name of ["prepare-review", "verify", "finish"]) {
      assert.equal(opNames(calls).includes(name), false, name);
    }
    assert.deepEqual(firstPayload(calls, "confirm-merged"), {
      number: ctx.issue,
      codeMerged: { pr: PR, sha: MERGE_COMMIT },
    });
    assert.deepEqual(savesOf(calls), []);
  });
}

test("an interrupted own merge reuses exact saved security approval and original integration authorization", async () => {
  const integrated = { ...REVISION, code: MOVED };
  const at = current(MERGED_REVISION, { ...MERGED_PR, headSha: MOVED });
  const integration = { reviewed: REVISION, revision: integrated };
  const { ctx, calls } = merging({
    state: { ...RECEIPT, integration, security: CLEARED },
    ops: { "current-revision": [at] },
  });
  const done = stateOf(await mergeRole(ctx), "next");
  assert.deepEqual(done.hardened, REVISION);
  assert.deepEqual(done.integration, integration);
  assert.deepEqual(done.codeMerged, CODE_MERGED.codeMerged);
  const { state: finished } = firstPayload(calls, "finish");
  assert.deepEqual(finished, done);
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(!opNames(calls).includes("prepare-review"));
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
});

test("an interrupted own merge with an exact rejection re-stops before recovery or another session", async () => {
  const security = {
    ...CLEARED,
    finding: {
      category: /** @type {const} */ ("rights"),
      reason: "src/chat.ts:3 exports private chats",
    },
  };
  const { ctx, calls } = merging({
    state: { ...RECEIPT, security },
    ops: { "current-revision": [AFTER_MERGE] },
  });
  const end = await mergeRole(ctx);
  assert.ok(end.kind === "stop");
  assert.equal(end.code, "rights");
  assert.deepEqual(end.state.security, security);
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
});

const MISMATCHES = [
  { name: "missing receipt", state: { merged: null } },
  { name: "missing authorization", state: { hardened: null } },
  {
    name: "receipt for other trusted inputs",
    state: { merged: { ...MERGED_REVISION, inputs: NEW_INPUTS } },
  },
  { name: "missing PR", at: current(MERGED_REVISION, null) },
  {
    name: "another PR",
    at: current(MERGED_REVISION, { ...MERGED_PR, number: PR + 1 }),
  },
  {
    name: "unmerged PR",
    at: current(MERGED_REVISION, { ...MERGED_PR, state: "OPEN" }),
  },
  {
    name: "another PR head",
    at: current(MERGED_REVISION, { ...MERGED_PR, headSha: MOVED }),
  },
  {
    name: "another merge",
    at: current(MERGED_REVISION, { ...MERGED_PR, mergeCommit: MOVED }),
  },
  { name: "another code revision", at: current({ code: MOVED }, MERGED_PR) },
  {
    name: "legacy receipt with a wiki",
    state: { merged: { ...MERGED_REVISION, wiki: MOVED } },
  },
  {
    name: "claim for another PR",
    state: { codeMerged: { pr: PR + 1, sha: MERGE_COMMIT } },
  },
  {
    name: "claim for another merge",
    state: { codeMerged: { pr: PR, sha: MOVED } },
  },
];

for (const mismatch of MISMATCHES) {
  test(`own-merge recovery refuses ${mismatch.name} without a session or finish`, async () => {
    const { ctx, calls } = merging({
      state: { ...RECEIPT, ...mismatch.state },
      ops: { "current-revision": [mismatch.at ?? AFTER_MERGE] },
    });
    const end = await mergeRole(ctx);
    assert.ok(end.kind !== "deferred");
    assert.notEqual(end.state.stage, "done");
    assert.equal(sessionsOf(calls).length, 0);
    assert.deepEqual(opNames(calls), ["current-revision"]);
  });
}

test("own-merge recovery requires an explicit authoritative PR head", async () => {
  const { headSha, ...withoutHead } = MERGED_PR;
  const { ctx, calls } = merging({
    state: RECEIPT,
    ops: { "current-revision": [{ ...AFTER_MERGE, pr: withoutHead }] },
  });
  await assert.rejects(mergeRole(ctx), {
    name: "OpsFailure",
    op: "current-revision",
  });
  assert.equal(sessionsOf(calls).length, 0);
});

test("new trusted inputs after the own merge return to Author instead of recovering the receipt", async () => {
  const at = current({ ...MERGED_REVISION, inputs: NEW_INPUTS }, MERGED_PR);
  const { ctx, calls } = merging({
    state: RECEIPT,
    gherkin: gherkinComment({ inputs: NEW_INPUTS }),
    ops: { "current-revision": [at] },
  });
  assert.equal(stateOf(await mergeRole(ctx), "next").stage, "author");
  assert.deepEqual(opNames(calls), ["current-revision"]);
  assert.equal(sessionsOf(calls).length, 0);
});

test("code that moves after an own merge missing security never opens a recovered security session or finishes", async () => {
  const at = current({ ...MERGED_REVISION, code: MOVED }, MERGED_PR);
  const { ctx, calls } = merging({
    state: RECEIPT,
    ops: {
      "current-revision": [AFTER_MERGE, at],
      "prepare-review": [PREPARED_MERGED],
    },
  });
  const state = stateOf(await mergeRole(ctx), "stop");
  assert.equal(state.security, null);
  assert.deepEqual(state.merged, MERGED_REVISION);
  assert.equal(sessionsOf(calls).length, 0);
  assert.ok(!opNames(calls).includes("prepare-review"));
  assert.ok(!opNames(calls).includes("finish"));
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
});
