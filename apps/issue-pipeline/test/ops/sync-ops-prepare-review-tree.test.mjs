// @ts-check
// prepare-review's headTree (#387, security-skip-unchanged): the tree of the
// head it diffed, which stays the same for a new head with the same code and
// changes when the base the branch is on moves or the issue's change is
// edited. Run through the ops CLI against a local origin, as
// sync-ops-prepare-review.test.mjs runs the rest of the reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { opsFixture } from "../ops-fixtures.mjs";

const fx = await opsFixture("sync-ops-prepare-review-tree");
const { fakeGh, sh, worktree } = fx;
// Each test's issue.
const ISSUE = { recommit: 31, rebase: 32, edit: 33 };
// The reply fields these tests read; headTree is checked by value.
const TREE_REPLY = z.looseObject({
  headSha: z.string(),
  headTree: z.unknown().optional(),
});

/** @typedef {{ headSha: string, headTree?: unknown }} TreeReply */

// prepare-review's reply for issue `n`.
/** @param {number} n @returns {TreeReply} */
function prepare(n) {
  fakeGh.reply([]);
  const out = fx.ask({ op: "prepare-review", number: n });
  return TREE_REPLY.parse(JSON.parse(out));
}

// The tree of `sha` in issue `n`'s worktree.
/** @param {number} n @param {string} sha @returns {string} */
function treeOf(n, sha) {
  return sh(`git -C ${worktree(n)} rev-parse ${sha}^{tree}`);
}

// Runs git in issue `n`'s worktree.
/** @param {number} n @param {string} args @returns {string} */
function gitIn(n, args) {
  return sh(`git -C ${worktree(n)} ${args}`);
}

test("prepare-review replies the head's tree, the same for an empty re-commit or a reworded head", () => {
  const n = ISSUE.recommit;
  fx.startBranch(n, "g", "one");
  const first = prepare(n);
  assert.equal(first.headTree, treeOf(n, first.headSha));
  gitIn(n, "commit -q --allow-empty -m again");
  const recommitted = prepare(n);
  gitIn(n, "commit -q --amend --allow-empty -m reworded");
  const reworded = prepare(n);
  const replies = [first, recommitted, reworded];
  const heads = new Set(replies.map((r) => r.headSha));
  assert.equal(heads.size, replies.length);
  assert.deepEqual(
    [recommitted.headTree, reworded.headTree],
    [first.headTree, first.headTree],
  );
});

test("prepare-review's tree changes when the branch is rebased onto a moved base", () => {
  const n = ISSUE.rebase;
  fx.startBranch(n, "g", "one");
  const before = prepare(n);
  fx.advanceBase("b32", "base");
  gitIn(n, "fetch -q origin");
  gitIn(n, "rebase -q origin/integration");
  const after = prepare(n);
  assert.notEqual(after.headSha, before.headSha);
  assert.equal(after.headTree, treeOf(n, after.headSha));
  assert.notEqual(after.headTree, before.headTree);
});

test("prepare-review's tree changes when the issue's own change is edited", () => {
  const n = ISSUE.edit;
  fx.startBranch(n, "g", "one");
  const before = prepare(n);
  fx.commitIn(n, "g", "two");
  const after = prepare(n);
  assert.equal(after.headTree, treeOf(n, after.headSha));
  assert.notEqual(after.headTree, before.headTree);
});
