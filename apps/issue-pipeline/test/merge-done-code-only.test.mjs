// @ts-check
// Done replay rechecks the merged result before obtaining or reusing clearance.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AFTER_MERGE,
  CODE_MERGED,
  FINISHED,
  MERGED_PR,
  MERGED_REVISION,
  merging,
  mutationsOf,
  NO_FINDING,
  PREPARED_MERGED,
} from "./merge-role-test-kit.mjs";
import {
  checksBefore,
  savesOf,
  sessionsOf,
  stateOf,
} from "./reviewer-and-merge-role-calls-kit.mjs";
import {
  COMMENT_ID,
  current,
  fakeContext,
  MERGE_COMMIT,
  mergeRole,
  REVISION,
} from "./reviewer-and-merge-role-kit.mjs";

const { mergedAuthorizationHolds } = await import("../src/ops/merge-guard.ts");

const DONE = {
  ...merging().ctx.state,
  stage: /** @type {const} */ ("done"),
  merged: MERGED_REVISION,
};

test("a code-only done completion rechecks M before reviewing missing security", async () => {
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
      "prepare-review": [{ ...PREPARED_MERGED, changedFiles: ["src/chat.ts"] }],
      "finish-wiki": [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
    sessions: [NO_FINDING],
  });
  const reviewed = stateOf(await mergeRole(ctx), "next");
  assert.equal(sessionsOf(calls).length, 1);
  assert.deepEqual(reviewed.security, {
    revision: codeOnly,
    commentId: COMMENT_ID,
    finding: null,
  });
  const saved = savesOf(calls).at(-1);
  assert.deepEqual(saved, reviewed);
  assert.ok(saved !== undefined);
  assert.equal(mergedAuthorizationHolds(saved, codeOnly, MERGED_PR), true);
  for (const boundary of /** @type {const} */ ([
    "prepare-review",
    "finish-wiki",
  ])) {
    const checks = checksBefore(calls, boundary);
    assert.deepEqual(checks.verify, { number: ctx.issue, ...CODE_MERGED });
  }
  assert.deepEqual(mutationsOf(calls), ["finish-wiki"]);
  assert.ok(sessionsOf(calls).every((session) => session.commits === false));
});

test("a done completion rechecks M before reusing exact clearance", async () => {
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
      "finish-wiki": [FINISHED],
      verify: [{ pass: true, headSha: MERGE_COMMIT, checks: [] }],
    },
  });
  stateOf(await mergeRole(ctx), "next");
  const checks = checksBefore(calls, "finish-wiki");
  assert.deepEqual(checks.verify, { number: ctx.issue, ...CODE_MERGED });
  assert.deepEqual(mutationsOf(calls), ["finish-wiki"]);
  assert.equal(sessionsOf(calls).length, 0);
});
