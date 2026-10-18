// @ts-check
// prepare-review's merged result (src/ops/merged-review.ts), through the ops
// CLI against a local origin and the fake gh: it detaches the issue's
// checkout at GitHub's confirmed merge commit, again safely; it refuses,
// moving and writing nothing, a checkout with uncommitted changes, a merge
// commit with no change against its first parent, and a checkout that
// doesn't end at the merge commit; and the detached checkout is no
// unpushed work: no stop pushes it, a wiki-only push accepts it, the
// current revision is the merge commit, and a stage job's teardown drops
// and pushes nothing.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { commentLines, githubComment } from "./fake-gh.mjs";
import { isolatedOpsFixture } from "./integration-source-test-kit.mjs";

const fx = await isolatedOpsFixture("merged-review-ops");
const { fakeGh, sh, worktree, originRef } = fx;
const { loadConfig, paths } = await import("../src/config.ts");
const { pushUnpushed } = await import("../src/unpushed.ts");
const { currentRevision } = await import("../src/revision.ts");
const { closeJobCheckout } = await import("../src/job/checkout.ts");
const { newIssueState } = await import("../src/state.ts");

const ISSUE = {
  merged: 41,
  dirty: 42,
  empty: 43,
  moved: 44,
  job: 45,
};
const PR = 9;
const BASE = "integration";
const STATE_COMMENT = 70;
const HOOK_MODE = 0o755;
const CONFIG = fx.configWith("plain.json", {});
const cfg = loadConfig(CONFIG);
const REVIEW_REPLY = z.looseObject({
  ok: z.literal(true),
  headSha: z.string(),
  diffPath: z.string(),
  bundleText: z.string(),
});
const ERROR_REPLY = z.object({ ok: z.literal(false), error: z.string() });
const PUSHED_REPLY = z.looseObject({
  ok: z.literal(true),
  headSha: z.string(),
});
const UNCOMMITTED =
  /uncommitted changes, so it can't be moved to the merged result; nothing was dropped/u;
const CHANGES_NOTHING = /changes nothing against its first parent/u;
const NOT_AT_MERGE = /not the merge commit/u;
const AT = "2026-10-15T01:00:00Z";

/** @param {string} out @returns {unknown} */
function parsed(out) {
  return JSON.parse(out);
}

// Merges issue `n`'s pushed branch into the base on origin with a merge
// commit, as GitHub would; returns the merge commit.
/** @param {number} n @returns {string} */
function mergeOnOrigin(n) {
  const seed = path.join(fx.root, "seed");
  sh(`cd ${seed} && git checkout -q ${BASE} && git pull -q origin ${BASE}`);
  sh(`cd ${seed} && git fetch -q origin agent/issue-${n}`);
  sh(`cd ${seed} && git merge -q --no-ff -m "Merge PR #${PR}" FETCH_HEAD`);
  sh(`cd ${seed} && git push -q origin HEAD:${BASE}`);
  return originRef(BASE);
}

// gh's `pr view` answer for issue `n`'s PR, merged as `sha` from `head`.
/** @param {number} n @param {string} sha @param {string} head @returns {import("./fake-gh.mjs").GhReply} */
function mergedView(n, sha, head) {
  const view = {
    number: PR,
    state: "MERGED",
    mergeCommit: { oid: sha },
    headRefName: `agent/issue-${n}`,
    headRefOid: head,
    baseRefName: BASE,
    isCrossRepository: false,
  };
  return { when: `pr view ${PR}`, stdout: JSON.stringify(view), keep: true };
}

// Issue `n`'s branch with `file` committed and pushed, merged on origin;
// returns its head and the merge commit.
/** @param {number} n @param {string} file @returns {{ head: string, sha: string }} */
function mergedBranch(n, file) {
  const head = fx.startBranch(n, file, `${file} line`);
  return { head, sha: mergeOnOrigin(n) };
}

// prepare-review of issue `n`'s merge as `merge.sha`, in `checkout` if
// given.
/**
 * @param {number} n
 * @param {{ head: string, sha: string }} merge
 * @param {string} tag
 * @param {object} [checkout]
 * @returns {unknown}
 */
function prepare(n, { head, sha }, tag, checkout) {
  fakeGh.reply([mergedView(n, sha, head)]);
  const request = {
    op: "prepare-review",
    number: n,
    tag,
    codeMerged: { pr: PR, sha },
  };
  if (checkout !== undefined) {
    return parsed(fx.ask({ ...request, checkout }, CONFIG));
  }
  return parsed(fx.ask(request, CONFIG));
}

/** @param {number} n @param {string} tag @returns {boolean} */
function reviewWritten(n, tag) {
  return fs.existsSync(path.join(paths.runDir(cfg, n), `review-${tag}`));
}

/** @param {string} dir @returns {string} */
function headOf(dir) {
  return sh(`git -C ${dir} rev-parse HEAD`);
}

const merged = mergedBranch(ISSUE.merged, "merged.txt");
const first = REVIEW_REPLY.parse(prepare(ISSUE.merged, merged, "r1"));

test("prepare-review detaches the checkout at the merge commit, and again gives the same review", () => {
  assert.equal(first.headSha, merged.sha);
  assert.equal(headOf(worktree(ISSUE.merged)), merged.sha);
  assert.ok(first.bundleText.includes("merged.txt line"), first.bundleText);
  const again = REVIEW_REPLY.parse(prepare(ISSUE.merged, merged, "r2"));
  assert.equal(again.headSha, merged.sha);
  assert.equal(again.bundleText, first.bundleText);
  assert.equal(headOf(worktree(ISSUE.merged)), merged.sha);
});

test("a checkout with uncommitted changes is refused, keeping them, its head and no review", () => {
  const branch = mergedBranch(ISSUE.dirty, "dirty.txt");
  const wt = worktree(ISSUE.dirty);
  for (const { file, tag } of [
    { file: "dirty.txt", tag: "tracked" },
    { file: "new.txt", tag: "untracked" },
  ]) {
    fs.writeFileSync(path.join(wt, file), "unsaved work\n");
    const reply = ERROR_REPLY.parse(prepare(ISSUE.dirty, branch, tag));
    assert.match(reply.error, UNCOMMITTED, tag);
    const kept = fs.readFileSync(path.join(wt, file), "utf8");
    assert.equal(kept, "unsaved work\n", tag);
    assert.equal(headOf(wt), branch.head, tag);
    assert.equal(reviewWritten(ISSUE.dirty, tag), false, tag);
    sh(`git -C ${wt} checkout -q -- . && git -C ${wt} clean -qf`);
  }
});

test("a merge commit with no change against its first parent is refused, moving and writing nothing", () => {
  fx.fetchClone();
  const wt = worktree(ISSUE.empty);
  const branch = `agent/issue-${ISSUE.empty}`;
  sh(
    `git -C ${paths.clone(cfg)} worktree add -q -B ${branch} ${wt} origin/${BASE}`,
  );
  sh(`git -C ${wt} commit -q --allow-empty -m start`);
  const head = fx.pushFrom(ISSUE.empty);
  const empty = { head, sha: mergeOnOrigin(ISSUE.empty) };
  const reply = ERROR_REPLY.parse(prepare(ISSUE.empty, empty, "empty"));
  assert.match(reply.error, CHANGES_NOTHING);
  assert.equal(headOf(wt), head);
  assert.equal(reviewWritten(ISSUE.empty, "empty"), false);
});

test("a checkout that doesn't end at the merge commit is refused, writing no review", () => {
  const branch = mergedBranch(ISSUE.moved, "moved.txt");
  const gitDir = sh(`git -C ${paths.clone(cfg)} rev-parse --absolute-git-dir`);
  const hook = path.join(gitDir, "hooks", "post-checkout");
  fs.writeFileSync(
    hook,
    '#!/bin/sh\n[ -n "$MOVED" ] || MOVED=1 git checkout -q --detach HEAD^1\n',
  );
  fs.chmodSync(hook, HOOK_MODE);
  try {
    const reply = ERROR_REPLY.parse(prepare(ISSUE.moved, branch, "moved"));
    assert.match(reply.error, NOT_AT_MERGE);
    assert.equal(reviewWritten(ISSUE.moved, "moved"), false);
  } finally {
    fs.rmSync(hook);
  }
});

test("the detached merge commit is no unpushed work: a stop pushes nothing and the revision is the merge", () => {
  assert.deepEqual(pushUnpushed(cfg, ISSUE.merged), []);
  assert.equal(originRef(`agent/issue-${ISSUE.merged}`), merged.head);
  const issue = {
    number: ISSUE.merged,
    title: "T",
    body: "",
    state: "open",
    user: { login: "a" },
    labels: [],
  };
  fakeGh.reply([
    {
      when: `api repos/o/r/issues/${ISSUE.merged}`,
      stdout: JSON.stringify(issue),
      keep: true,
    },
    {
      when: `issues/${ISSUE.merged}/comments?per_page`,
      stdout: "",
      keep: true,
    },
    mergedView(ISSUE.merged, merged.sha, merged.head),
  ]);
  const current = currentRevision(cfg, ISSUE.merged, { pr: PR });
  assert.equal(current.revision.code, merged.sha);
  assert.equal(current.checkoutHead, merged.sha);
});

test("a wiki-only push from the detached merge commit pushes no code", () => {
  const saved = {
    ...newIssueState(ISSUE.merged),
    stage: "review",
    pr: PR,
    codeMerged: { pr: PR, sha: merged.sha },
  };
  const comment = githubComment({
    id: STATE_COMMENT,
    body: `<!-- agent-pipeline:state\n${JSON.stringify(saved)}\n-->`,
    login: "a",
    created: AT,
    updated: AT,
  });
  fakeGh.reply([
    {
      when: `issues/${ISSUE.merged}/comments?per_page`,
      stdout: commentLines([comment]),
      keep: true,
    },
  ]);
  const request = { op: "push", number: ISSUE.merged, wikiOnly: true };
  const reply = PUSHED_REPLY.parse(parsed(fx.ask(request, CONFIG)));
  assert.equal(reply.headSha, merged.sha);
  assert.equal(originRef(`agent/issue-${ISSUE.merged}`), merged.head);
});

test("a stage job's teardown of a checkout detached at the merge drops and pushes nothing", async () => {
  const branch = mergedBranch(ISSUE.job, "job.txt");
  const name = `agent/issue-${ISSUE.job}`;
  const root = path.join(fx.root, "jobs", `issue-${ISSUE.job}-review`);
  const repo = path.join(root, "repo");
  sh(`git clone -q ${path.join(fx.root, "origin.git")} ${repo}`);
  sh(`git -C ${repo} checkout -q -B ${name} origin/${name}`);
  const checkout = { issue: ISSUE.job, dir: repo, branch: name };
  REVIEW_REPLY.parse(prepare(ISSUE.job, branch, "job", checkout));
  assert.equal(headOf(repo), branch.sha);
  let pushes = 0;
  const dropped = await closeJobCheckout(
    cfg,
    ISSUE.job,
    { root, repo, docs: null, wiki: "read", key: "review-1" },
    () => {
      pushes += 1;
      return Promise.resolve();
    },
  );
  assert.deepEqual(dropped, { lost: [], patches: [] });
  assert.equal(pushes, 0);
  assert.equal(fs.existsSync(root), false);
  assert.equal(originRef(name), branch.head);
});
