// @ts-check
// finish-sync with the baseSha sync-base rebased onto (#279): a resolution is
// checked against that commit, so it is pushed even when the base moved during
// the fix, and the branch is then behind the base, which the merge op refuses. A head not on that
// commit, or a commit that isn't on the base, is refused and nothing is pushed.
// sync-base always rebases onto the base now that branches aren't stacked on
// a prerequisite's branch (#268; the prerequisite holds the issue instead,
// orchestrator.test), so sync-ops-stacked.test.mjs is retired: the rebase is
// sync-ops.test "sync-base rebases onto a moved base and pushes", and the
// finish-sync check of the commit it rebased onto is this file's.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { okLine, opsFixture } from "./ops-fixture.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

const fx = await opsFixture("sync-ops-base-sha");
const { fakeGh, originRef, sh, worktree } = fx;
const ISSUE = { movedBase: 61, olderBase: 62, offBase: 63 };
const CODE = { codeChanged: true, wikiAhead: 0 };

// Runs an op after queuing `replies`; returns its stdout and the gh calls.
/** @param {object} request @param {GhReply[]} [replies] @returns {{ out: string, calls: string[][] }} */
function ask(request, replies = []) {
  fakeGh.reply(replies);
  const out = fx.ask(request);
  return { out, calls: fakeGh.calls() };
}

// A conflicting rebase kept in the worktree for a writer, as sync-base leaves
// it. Returns the branch's head before it, the baseSha sync-base replied and
// the gh calls it made.
/** @param {number} n @returns {{ headSha: string, baseSha: string, calls: string[][] }} */
function keptConflict(n) {
  const headSha = fx.startBranch(n, `c${n}`, "mine");
  fx.advanceBase(`c${n}`, "theirs");
  const { out, calls } = ask({
    op: "sync-base",
    number: n,
    keepConflict: true,
  });
  const { baseSha } = JSON.parse(out);
  return { headSha, baseSha, calls };
}

// Resolves the kept rebase of `c<n>` and finishes it, as a writer would.
/** @param {number} n @returns {string} */
function resolve(n) {
  const wt = worktree(n);
  fs.writeFileSync(path.join(wt, `c${n}`), "resolved\n");
  sh(`cd ${wt} && git add c${n} && GIT_EDITOR=true git rebase --continue`);
  return sh(`git -C ${wt} rev-parse HEAD`);
}

// finish-sync's refusal for `reason`, beside what it did: no gh calls, and the
// worktree and origin left at `headSha`.
/** @param {number} n @param {string} baseSha @param {string} reason @param {string} headSha @returns {{ got: object, expected: object }} */
function failure(n, baseSha, reason, headSha) {
  const { out, calls } = ask({ op: "finish-sync", number: n, baseSha });
  const got = {
    out,
    calls,
    inRebase: fx.inRebase(n),
    worktree: fx.worktreeState(n),
    origin: originRef(`agent/issue-${n}`),
  };
  const expected = {
    out: okLine("finish-sync", { resolved: false, reason }),
    calls: [],
    inRebase: false,
    worktree: { head: headSha, status: "" },
    origin: headSha,
  };
  return { got, expected };
}

test("finish-sync pushes a resolution onto its baseSha after the base moved, and merge finds it behind", () => {
  const n = ISSUE.movedBase;
  const { baseSha, calls: kept } = keptConflict(n);
  assert.deepEqual(kept, []);
  resolve(n);
  fx.advanceBase("later", "unrelated");
  fx.fetchClone();
  const { out, calls } = ask({ op: "finish-sync", number: n, baseSha });
  assert.deepEqual(calls, []);
  const headSha = originRef(`agent/issue-${n}`);
  assert.equal(
    out,
    okLine("finish-sync", { resolved: true, headSha, ...CODE }),
  );
  assert.equal(sh(`git -C ${worktree(n)} rev-parse HEAD`), headSha);
  assert.equal(originRef(`${headSha}^`), baseSha);
  const record = { sha: headSha, op: "finish-sync", dated: true };
  assert.deepEqual(pushRecord(fx.root, n), record);
  // The pushed head sits on the old baseSha, behind the moved base: the
  // state the merge op refuses as "behind" (test/merge-op.test.mjs, "merge
  // refuses a head behind its base without merging").
  const base = originRef("integration");
  assert.notEqual(base, baseSha);
  assert.equal(
    sh(
      `git -C ${worktree(n)} merge-base --is-ancestor ${base} ${headSha} && echo ahead || echo behind`,
    ),
    "behind",
  );
});

test("finish-sync refuses a head not based on its baseSha", () => {
  const n = ISSUE.olderBase;
  const { baseSha, calls } = keptConflict(n);
  assert.deepEqual(calls, []);
  const wt = worktree(n);
  sh(`git -C ${wt} rebase --abort`);
  fs.writeFileSync(path.join(wt, `c${n}`), "resolved on the old base\n");
  sh(`cd ${wt} && git commit -qam "resolve on the old base"`);
  const pushed = originRef(`agent/issue-${n}`);
  const reason = `HEAD is not based on ${baseSha}`;
  const { got, expected } = failure(n, baseSha, reason, pushed);
  assert.deepEqual(got, expected);
});

test("finish-sync refuses a baseSha that is not on the base", () => {
  const n = ISSUE.offBase;
  const { headSha, calls } = keptConflict(n);
  assert.deepEqual(calls, []);
  resolve(n);
  const reason = `${headSha} is not on origin/integration`;
  const { got, expected } = failure(n, headSha, reason, headSha);
  assert.deepEqual(got, expected);
});
