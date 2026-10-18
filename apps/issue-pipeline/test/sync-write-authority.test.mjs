// @ts-check
// Sync may neither discard a refused resolution nor bypass the shared push guard.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  historyReply,
  initialWriteStateReply,
} from "./initial-write-state-fixtures.mjs";
import { opsFixture } from "./ops-fixture.mjs";

const fx = await opsFixture("sync-write-authority");
fx.fakeGh.requireReplies();
const { ghIsRead } = await import("../src/github.ts");
const { newIssueState } = await import("../src/state.ts");
const PR = 42;
const FIRST_REFUSAL_ISSUE = 70;

/** @param {number} n @param {object | null} state @returns {import("./fake-gh.mjs").GhReply} */
function authority(n, state) {
  const reply = initialWriteStateReply(n);
  if (state === null) {
    return { ...reply, stdout: "" };
  }
  const comment = JSON.parse(reply.stdout ?? "{}");
  comment.body = `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
  return { ...reply, stdout: JSON.stringify(comment) };
}

/** @param {number} n @returns {import("../src/state.ts").IssueState} */
function saved(n) {
  return { ...newIssueState(n), stage: "merge", branch: `agent/issue-${n}` };
}

/** @param {number} n @returns {object} */
function snapshot(n) {
  const wt = fx.worktree(n);
  return {
    ...fx.worktreeState(n),
    index: fx.sh(`git -C ${wt} ls-files --stage`),
    file: fs.readFileSync(path.join(wt, `c${n}`), "utf8"),
    dirty: fs.readFileSync(path.join(wt, "scratch.txt"), "utf8"),
    rebase: fx.inRebase(n),
  };
}

/** @param {number} n @returns {{remote: string, reply: {inRebase?: boolean, error?: string}}} */
function keepConflict(n) {
  const remote = fx.startBranch(n, `c${n}`, "mine");
  fx.advanceBase(`c${n}`, "theirs");
  fx.fakeGh.reply([authority(n, saved(n)), historyReply(n)]);
  const reply = JSON.parse(
    fx.ask({ op: "sync-base", number: n, keepConflict: true }),
  );
  fs.writeFileSync(
    path.join(fx.worktree(n), "scratch.txt"),
    "exact dirty work\n",
  );
  return { remote, reply };
}

for (const [at, denied] of [
  "missing",
  "malformed",
  "saved-merge",
  "live-merge",
  "rejected",
].entries()) {
  test(`sync entry refuses ${denied} before abort/reset/rebase; exact conflict and dirty work remain`, () => {
    const n = FIRST_REFUSAL_ISSUE + at;
    const { remote, reply: kept } = keepConflict(n);
    assert.equal(kept.inRebase, true, kept.error);
    const before = snapshot(n);
    const state = saved(n);
    const merged = { code: remote, wiki: null, inputs: "trusted" };
    let actual = authority(n, state);
    if (denied === "missing") {
      actual = authority(n, null);
    }
    if (denied === "malformed") {
      actual = authority(n, { ...state, security: {} });
    }
    if (denied === "saved-merge") {
      actual = authority(n, { ...state, merged });
    }
    if (denied === "rejected") {
      actual = authority(n, {
        ...state,
        security: {
          revision: merged,
          commentId: 9,
          finding: { category: "abuse-risk", reason: "rejected" },
        },
      });
    }
    let history = historyReply(n);
    if (denied === "live-merge") {
      history = historyReply(n, [PR]);
    }
    fx.fakeGh.reply([
      actual,
      history,
      {
        when: `pr view ${PR}`,
        stdout: JSON.stringify({
          number: PR,
          state: "MERGED",
          mergeCommit: { oid: remote },
          headRefName: `agent/issue-${n}`,
          headRefOid: remote,
          baseRefName: "integration",
          isCrossRepository: false,
        }),
        keep: true,
      },
    ]);
    for (const request of [
      { op: "sync-base", number: n },
      { op: "finish-sync", number: n },
      { op: "finish-sync", number: n, abort: true },
    ]) {
      const reply = JSON.parse(fx.ask(request));
      assert.equal(reply.ok, false, JSON.stringify(reply));
      assert.deepEqual(snapshot(n), before);
      assert.equal(fx.originRef(`agent/issue-${n}`), remote);
      assert.equal(
        fx.sh(`git -C ${fx.worktree(n)} show ${remote}:c${n}`),
        "mine",
      );
    }
    assert.deepEqual(fx.fakeGh.writes(ghIsRead), []);
  });
}

test("finish-sync rechecks authority immediately before its raw push and retains a refused local resolution", () => {
  const n = 80;
  const { remote, reply: kept } = keepConflict(n);
  assert.equal(kept.inRebase, true, kept.error);
  const wt = fx.worktree(n);
  fs.rmSync(path.join(wt, "scratch.txt"));
  fs.writeFileSync(path.join(wt, `c${n}`), "exact resolution\n");
  fx.sh(`cd ${wt} && git add c${n} && GIT_EDITOR=true git rebase --continue`);
  const before = fx.worktreeState(n);
  const state = saved(n);
  fx.fakeGh.reply([
    { ...authority(n, state), keep: false },
    authority(n, { ...state, codeMerged: { pr: PR, sha: remote } }),
    historyReply(n),
  ]);
  const reply = JSON.parse(fx.ask({ op: "finish-sync", number: n }));
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.deepEqual(fx.worktreeState(n), before);
  assert.equal(
    fs.readFileSync(path.join(wt, `c${n}`), "utf8"),
    "exact resolution\n",
  );
  assert.equal(fx.originRef(`agent/issue-${n}`), remote);
  assert.deepEqual(fx.fakeGh.writes(ghIsRead), []);
});

test("sync-base's final authority refusal restores its original unpushed local commit, never the older remote", () => {
  const n = 81;
  const remote = fx.startBranch(n, `c${n}`, "mine");
  const local = fx.commitIn(n, "held.txt", "exact local C");
  fx.advanceBase(`base${n}`, "new base");
  const before = fx.worktreeState(n);
  const state = saved(n);
  fx.fakeGh.reply([
    { ...authority(n, state), keep: false },
    authority(n, { ...state, codeMerged: { pr: PR, sha: remote } }),
    historyReply(n),
  ]);
  const reply = JSON.parse(fx.ask({ op: "sync-base", number: n }));
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.deepEqual(fx.worktreeState(n), before);
  assert.equal(before.head, local);
  assert.notEqual(local, remote);
  assert.equal(
    fx.sh(`git -C ${fx.worktree(n)} show HEAD:held.txt`),
    "exact local C",
  );
  assert.equal(fx.originRef(`agent/issue-${n}`), remote);
  assert.deepEqual(fx.fakeGh.writes(ghIsRead), []);
});
