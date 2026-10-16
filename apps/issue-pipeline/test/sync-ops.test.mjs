// @ts-check
// sync-base and finish-sync: their replies and the branch on origin, run
// through the ops CLI against a local origin. Neither calls gh. prepare-review's
// tests are in sync-ops-prepare-review.test.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { okLine, opsFixture } from "./ops-fixture.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const fx = await opsFixture("sync-ops");
const { fakeGh, originRef, sh, worktree } = fx;
const BASE = "origin/integration";
// Each test's issue. Two tests share 33, as they always have.
const ISSUE = {
  upToDate: 31,
  movedBase: 32,
  refusedPush: 33,
  conflict: 33,
  keptConflict: 34,
  unfinished: 41,
  aborted: 42,
  abortedWithReason: 43,
  uncommitted: 44,
  offBase: 45,
  noCommits: 46,
  markers: 47,
  finished: 48,
};
const UNCOMMITTED_FILES = 21;
const NAME_DIGITS = 2;
const MARKER_ROUNDS = 4;
const MARKERS_SHOWN = 10;
const EXECUTABLE = 0o755;

// Runs an op; returns its stdout and the gh calls it made.
/** @param {object} request @param {string} [config] @returns {{ out: string, calls: string[][] }} */
function ask(request, config) {
  fakeGh.reply([]);
  const out = fx.ask(request, config);
  return { out, calls: fakeGh.calls() };
}

/** @param {string} dir @param {string} args @returns {string} */
function gitIn(dir, args) {
  return sh(`git -C ${dir} ${args}`);
}

// What a branch with a code change and no wiki reports.
const CODE = { codeChanged: true, wikiAhead: 0 };

test("sync-base leaves an up-to-date branch alone", () => {
  const headSha = fx.startBranch(ISSUE.upToDate, "g", "one");
  const { out, calls } = ask({ op: "sync-base", number: ISSUE.upToDate });
  assert.deepEqual(calls, []);
  assert.equal(
    out,
    okLine("sync-base", { changed: false, conflict: false, headSha, ...CODE }),
  );
  assert.equal(originRef("agent/issue-31"), headSha);
});

test("sync-base rebases onto a moved base and pushes", () => {
  const before = fx.startBranch(ISSUE.movedBase, "g", "one");
  const base = fx.advanceBase("b32", "base");
  const { out, calls } = ask({ op: "sync-base", number: ISSUE.movedBase });
  assert.deepEqual(calls, []);
  const headSha = originRef("agent/issue-32");
  assert.notEqual(headSha, before);
  assert.equal(
    out,
    okLine("sync-base", { changed: true, conflict: false, headSha, ...CODE }),
  );
  assert.equal(originRef(`${headSha}^`), base);
  const record = { sha: headSha, op: "sync-base", dated: true };
  assert.deepEqual(pushRecord(fx.root, ISSUE.movedBase), record);
});

test("sync-base whose push origin refuses goes back to its old head", () => {
  const n = ISSUE.refusedPush;
  const before = fx.startBranch(n, "g", "one");
  fx.advanceBase("b33", "base");
  const hook = path.join(fx.root, "origin.git", "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: EXECUTABLE });
  /** @type {{ out: string, calls: string[][] }} */
  let refused = { out: "", calls: [] };
  try {
    refused = ask({ op: "sync-base", number: n });
  } finally {
    fs.rmSync(hook);
  }
  const { out, calls } = refused;
  assert.deepEqual(calls, []);
  assert.equal(JSON.parse(out).ok, false);
  assert.equal(originRef("agent/issue-33"), before);
  assert.deepEqual(fx.worktreeState(n), { head: before, status: "" });
});

// A branch whose file `c<n>` conflicts with the same file added on the base.
/** @param {number} n @returns {{ headSha: string, baseSha: string }} */
function conflicting(n) {
  const headSha = fx.startBranch(n, `c${n}`, "mine");
  const baseSha = fx.advanceBase(`c${n}`, "theirs");
  return { headSha, baseSha };
}

/** @param {number} n @param {boolean} inRebase @param {string} baseSha @returns {string} */
function conflictLine(n, inRebase, baseSha) {
  const conflicts = [`c${n}`];
  return okLine("sync-base", {
    changed: false,
    conflict: true,
    inRebase,
    conflicts,
    baseSha,
  });
}

test("sync-base reports a conflict and aborts the rebase", () => {
  const n = ISSUE.conflict;
  const { headSha, baseSha } = conflicting(n);
  const { out, calls } = ask({ op: "sync-base", number: n });
  assert.deepEqual(calls, []);
  assert.equal(out, conflictLine(n, false, baseSha));
  assert.equal(fx.inRebase(n), false);
  assert.deepEqual(fx.worktreeState(n), { head: headSha, status: "" });
  assert.equal(originRef("agent/issue-33"), headSha);
});

test("sync-base keeps a conflicting rebase, and resets it on the next run", () => {
  const n = ISSUE.keptConflict;
  const { headSha, baseSha } = conflicting(n);
  const kept = ask({ op: "sync-base", number: n, keepConflict: true });
  assert.deepEqual(kept.calls, []);
  assert.equal(kept.out, conflictLine(n, true, baseSha));
  assert.equal(fx.inRebase(n), true);
  const again = ask({ op: "sync-base", number: n, keepConflict: false });
  assert.deepEqual(again.calls, []);
  assert.equal(again.out, conflictLine(n, false, baseSha));
  assert.equal(fx.inRebase(n), false);
  assert.deepEqual(fx.worktreeState(n), { head: headSha, status: "" });
});

// A conflicting rebase kept in the worktree for a writer, as sync-base leaves it.
// Returns the branch's head before it, and the gh calls sync-base made.
/** @param {number} n @returns {{ headSha: string, calls: string[][] }} */
function keptConflict(n) {
  const { headSha } = conflicting(n);
  const { calls } = ask({ op: "sync-base", number: n, keepConflict: true });
  return { headSha, calls };
}

// Runs finish-sync expecting `reason`; returns what it did beside what it should
// have: that reply and no gh calls, with the worktree and origin left at `headSha`.
/** @param {number} n @param {object} request @param {string} reason @param {string} [headSha] @returns {{ got: object, expected: object }} */
function failure(n, request, reason, headSha = originRef(`agent/issue-${n}`)) {
  const { out, calls } = ask({ op: "finish-sync", number: n, ...request });
  const state = {
    calls: [],
    inRebase: false,
    worktree: { head: headSha, status: "" },
    origin: headSha,
  };
  const got = {
    out,
    calls,
    inRebase: fx.inRebase(n),
    worktree: fx.worktreeState(n),
    origin: originRef(`agent/issue-${n}`),
  };
  return {
    got,
    expected: {
      out: okLine("finish-sync", { resolved: false, reason }),
      ...state,
    },
  };
}

test("finish-sync resets the worktree on an abort or an unfinished rebase", () => {
  const unfinishedConflict = keptConflict(ISSUE.unfinished);
  assert.deepEqual(unfinishedConflict.calls, []);
  const unfinished = failure(
    ISSUE.unfinished,
    {},
    "the rebase was not finished",
    unfinishedConflict.headSha,
  );
  assert.deepEqual(unfinished.got, unfinished.expected);
  const { headSha: head, calls } = keptConflict(ISSUE.aborted);
  assert.deepEqual(calls, []);
  const aborted = failure(ISSUE.aborted, { abort: true }, "aborted", head);
  assert.deepEqual(aborted.got, aborted.expected);
  assert.deepEqual(keptConflict(ISSUE.abortedWithReason).calls, []);
  const withReason = failure(
    ISSUE.abortedWithReason,
    { abort: true, reason: "no time left" },
    "no time left",
  );
  assert.deepEqual(withReason.got, withReason.expected);
});

test("finish-sync refuses a worktree with uncommitted changes", () => {
  fx.startBranch(ISSUE.uncommitted, "g", "one");
  const names = Array.from(
    { length: UNCOMMITTED_FILES },
    (_, at) => `u${String(at + 1).padStart(NAME_DIGITS, "0")}`,
  );
  for (const name of names) {
    fs.writeFileSync(path.join(worktree(ISSUE.uncommitted), name), "x\n");
  }
  const lines = names.slice(1).map((name) => `?? ${name}`);
  const reason = `the worktree has uncommitted changes:\n${lines.join("\n")}`;
  const { got, expected } = failure(ISSUE.uncommitted, {}, reason);
  assert.deepEqual(got, expected);
});

test("finish-sync refuses a branch not on the base", () => {
  fx.startBranch(ISSUE.offBase, "g", "one");
  fx.advanceBase("b45", "base");
  fx.fetchClone();
  const { got, expected } = failure(
    ISSUE.offBase,
    {},
    `HEAD is not based on ${BASE}`,
  );
  assert.deepEqual(got, expected);
});

test("finish-sync refuses a branch with no commits left", () => {
  assert.deepEqual(keptConflict(ISSUE.noCommits).calls, []);
  gitIn(worktree(ISSUE.noCommits), "rebase --abort");
  gitIn(worktree(ISSUE.noCommits), `reset -q --hard ${BASE}`);
  const { got, expected } = failure(
    ISSUE.noCommits,
    {},
    "the branch has no commits left after the rebase",
  );
  assert.deepEqual(got, expected);
});

test("finish-sync refuses conflict markers", () => {
  const round = ["<<<<<<< ours", "=======", ">>>>>>> theirs"];
  const markers = Array.from({ length: MARKER_ROUNDS }, () => round).flat();
  fx.startBranch(
    ISSUE.markers,
    "m",
    ["<<<<<<<x", ...markers, "======= no"].join("\n"),
  );
  const shown = markers.slice(0, MARKERS_SHOWN).map((line) => `+${line}`);
  const { got, expected } = failure(
    ISSUE.markers,
    {},
    `conflict markers remain:\n${shown.join("\n")}`,
  );
  assert.deepEqual(got, expected);
});

test("finish-sync pushes a finished rebase", () => {
  assert.deepEqual(keptConflict(ISSUE.finished).calls, []);
  const wt = worktree(ISSUE.finished);
  fs.writeFileSync(path.join(wt, "c48"), "resolved\n");
  sh(`cd ${wt} && git add c48 && GIT_EDITOR=true git rebase --continue`);
  const { out, calls } = ask({ op: "finish-sync", number: ISSUE.finished });
  assert.deepEqual(calls, []);
  const headSha = originRef("agent/issue-48");
  assert.equal(
    out,
    okLine("finish-sync", { resolved: true, headSha, ...CODE }),
  );
  assert.equal(gitIn(wt, "rev-parse HEAD"), headSha);
  assert.equal(originRef(`${headSha}^`), originRef("integration"));
  const record = { sha: headSha, op: "finish-sync", dated: true };
  assert.deepEqual(pushRecord(fx.root, ISSUE.finished), record);
});
