// @ts-check
// Done replay confirms the merged result read-only before reusing clearance;
// missing clearance stops without a postmerge suite or Security (#185).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  opNames,
  opPayloads,
  savesOf,
  sessionsOf,
  stateOf,
} from "../reviewer-and-merge-role-calls-test-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  MERGE_COMMIT,
  mergeRole,
  REVISION,
} from "../reviewer-and-merge-role-test-kit.mjs";
import {
  AFTER_MERGE,
  CODE_MERGED,
  CONFIRMED,
  FINISHED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  NO_FINDING,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";

const { mergedAuthorizationHolds } = await import(
  "../../../src/ops/merge-guard.ts"
);

const DONE = {
  ...merging().ctx.state,
  stage: /** @type {const} */ ("done"),
  merged: MERGED_REVISION,
};

test("a code-only done completion without security stops after read-only confirmation, never reviewing M", async () => {
  // Saved while the pipeline had a wiki: its revisions name a null wiki head.
  const codeOnly = { ...MERGED_REVISION, wiki: null };
  const afterCodeMerge = current(codeOnly, AFTER_MERGE.pr);
  const { ctx, calls } = fakeContext({
    stage: "merge",
    state: {
      ...DONE,
      hardened: { ...REVISION, wiki: null },
      merged: codeOnly,
      flows: { code: true },
    },
    ops: {
      "current-revision": [afterCodeMerge, afterCodeMerge],
      "confirm-merged": [CONFIRMED],
      "prepare-review": [{ ...PREPARED_MERGED, changedFiles: ["src/chat.ts"] }],
      finish: [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
    sessions: [NO_FINDING],
  });
  const stopped = stateOf(await mergeRole(ctx), "stop");
  assert.equal(sessionsOf(calls).length, 0);
  assert.equal(stopped.security, null);
  assert.deepEqual(stopped.merged, codeOnly);
  assert.equal(mergedAuthorizationHolds(stopped, codeOnly, MERGED_PR), true);
  assert.deepEqual(opPayloads(calls, "confirm-merged"), [
    { number: ctx.issue, ...CODE_MERGED },
  ]);
  for (const name of ["verify", "prepare-review"]) {
    assert.deepEqual(opPayloads(calls, name), []);
  }
  assert.deepEqual(mutationsOf(calls), []);
  assert.deepEqual(savesOf(calls), []);
});

test("a done completion confirms M read-only before reusing exact clearance", async () => {
  const { ctx, calls } = fakeContext({
    stage: "merge",
    state: {
      ...DONE,
      security: {
        revision: MERGED_REVISION,
        commentId: COMMENT_ID,
        finding: null,
      },
    },
    ops: {
      "current-revision": [AFTER_MERGE],
      "confirm-merged": [CONFIRMED],
      finish: [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  stateOf(await mergeRole(ctx), "next");
  const names = opNames(calls);
  assert.ok(names.indexOf("confirm-merged") < names.indexOf("finish"));
  assert.deepEqual(opPayloads(calls, "confirm-merged"), [
    { number: ctx.issue, ...CODE_MERGED },
  ]);
  assert.deepEqual(opPayloads(calls, "verify"), []);
  assert.deepEqual(mutationsOf(calls), ["finish"]);
  assert.equal(sessionsOf(calls).length, 0);
});
