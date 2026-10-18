// @ts-check
// An interrupted own merge resumes from its saved receipt and original
// authorization, never a fabricated hardening of the merge SHA. GitHub
// independently confirms both the authorized PR head and the merge commit.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTER_MERGE,
  CODE_MERGED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
} from "./merge-role-test-kit.mjs";
import {
  firstPayload,
  opNames,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  gherkinComment,
  HEAD,
  MERGE_COMMIT,
  MOVED,
  mergeRole,
  NEW_INPUTS,
  PR,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const RECEIPT = { ...CODE_MERGED, merged: MERGED_REVISION };
const CLEARED = {
  revision: MERGED_REVISION,
  commentId: COMMENT_ID,
  finding: null,
};
const FORBIDDEN = ["merge", "push", "sync-base", "wiki-sync", "ready-pr"];

for (const codeMerged of [null, CODE_MERGED.codeMerged]) {
  test(`an interrupted own merge resumes missing security with codeMerged ${String(codeMerged?.sha ?? null)}, no writer or second merge`, async () => {
    const interrupted = merging({
      ops: {
        "prepare-review": [() => Promise.reject(new Error("interrupted"))],
      },
    });
    await assert.rejects(mergeRole(interrupted.ctx), {
      message: "interrupted",
    });
    const [receipt] = savesOf(interrupted.calls);
    assert.ok(receipt !== undefined);
    assert.deepEqual(receipt.merged, MERGED_REVISION);
    const { ctx, calls } = merging({
      state: { ...receipt, codeMerged },
      ops: { "current-revision": [AFTER_MERGE, AFTER_MERGE] },
    });
    const done = stateOf(await mergeRole(ctx), "next");
    assert.equal(done.stage, "done");
    assert.deepEqual(done.hardened, REVISION);
    assert.equal(done.integration, null);
    assert.deepEqual(done.codeMerged, codeMerged);
    assert.deepEqual(done.security, CLEARED);
    assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
    const sessions = sessionsOf(calls);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.phase, "security-review");
    assert.equal(sessions[0]?.commits, false);
    const { codeMerged: preparedMerge } = firstPayload(calls, "prepare-review");
    assert.deepEqual(preparedMerge, { pr: PR, sha: MERGE_COMMIT });
    const { revision, state: published } = firstPayload(calls, "publish");
    assert.deepEqual(revision, REVISION);
    assert.deepEqual(
      published,
      savesOf(calls).find((state) => state.security !== null),
    );
    const { state: finished } = firstPayload(calls, "finish-wiki");
    assert.deepEqual(finished, done);
    assert.equal(savesOf(calls)[0]?.verifiedSha, MERGE_COMMIT);
    assert.deepEqual(savesOf(calls).at(-2)?.security, CLEARED);
    assert.deepEqual(firstPayload(calls, "verify"), {
      number: ctx.issue,
      codeMerged: { pr: PR, sha: MERGE_COMMIT },
    });
    assert.ok(savesOf(calls).every((state) => state.codeMerged === codeMerged));
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
  const { revision } = firstPayload(calls, "publish");
  assert.deepEqual(revision, integrated);
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
    name: "another wiki",
    at: current({ ...MERGED_REVISION, wiki: MOVED }, MERGED_PR),
  },
  {
    name: "receipt for another wiki",
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
  test(`own-merge recovery refuses ${mismatch.name} without a session, publish or finish`, async () => {
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
  assert.equal(headSha, HEAD);
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

test("a wiki race during the recovered security session discards it and never publishes", async () => {
  const at = current({ ...MERGED_REVISION, wiki: MOVED }, MERGED_PR);
  const { ctx, calls } = merging({
    state: RECEIPT,
    ops: { "current-revision": [AFTER_MERGE, at] },
  });
  const state = stateOf(await mergeRole(ctx), "wait");
  assert.equal(state.security, null);
  assert.ok(!opNames(calls).includes("publish"));
  assert.ok(!opNames(calls).includes("finish-wiki"));
  assert.ok(opNames(calls).every((name) => !FORBIDDEN.includes(name)));
});
