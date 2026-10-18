// @ts-check
// prepare-review's patchId (#394, review-keeps-on-clean-rebase): the patch id
// of the branch's changes against its merge base, which stays the same when
// the branch is rebased cleanly onto a moved base and changes when the issue's
// change is edited. Run through the ops CLI against a local origin, as
// sync-ops-prepare-review-tree.test.mjs runs headTree.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("sync-ops-prepare-review-patch-id");
const { fakeGh, sh, worktree } = fx;
// Each test's issue.
const ISSUE = { rebase: 41, edit: 42, empty: 43 };
const PATCH_ID = /^[0-9a-f]{40}$/u;
// The reply fields these tests read; patchId is checked by value.
const PATCH_REPLY = z.looseObject({
  headSha: z.string(),
  patchId: z.unknown().optional(),
});

/** @typedef {{ headSha: string, patchId?: unknown }} PatchReply */

// prepare-review's reply for issue `n`.
/** @param {number} n @returns {PatchReply} */
function prepare(n) {
  fakeGh.reply([]);
  const out = fx.ask({ op: "prepare-review", number: n });
  return PATCH_REPLY.parse(JSON.parse(out));
}

// Runs git in issue `n`'s worktree.
/** @param {number} n @param {string} args @returns {string} */
function gitIn(n, args) {
  return sh(`git -C ${worktree(n)} ${args}`);
}

test("prepare-review's patch id stays the same when the branch is rebased cleanly onto a moved base", () => {
  const n = ISSUE.rebase;
  fx.startBranch(n, "g", "one");
  const before = prepare(n);
  assert.match(String(before.patchId), PATCH_ID);
  fx.advanceBase("b41", "base");
  gitIn(n, "fetch -q origin");
  gitIn(n, "rebase -q origin/integration");
  const after = prepare(n);
  assert.notEqual(after.headSha, before.headSha);
  assert.equal(after.patchId, before.patchId);
});

test("prepare-review's patch id changes when the issue's own change is edited", () => {
  const n = ISSUE.edit;
  fx.startBranch(n, "g", "one");
  const before = prepare(n);
  fx.commitIn(n, "g", "two");
  const after = prepare(n);
  assert.match(String(after.patchId), PATCH_ID);
  assert.notEqual(after.patchId, before.patchId);
});

test("prepare-review's patch id is null for a branch with no changes", () => {
  const n = ISSUE.empty;
  fx.startBranch(n, "g", "one");
  gitIn(n, "rm -q g");
  gitIn(n, "commit -qm drop");
  assert.equal(prepare(n).patchId, null);
});
