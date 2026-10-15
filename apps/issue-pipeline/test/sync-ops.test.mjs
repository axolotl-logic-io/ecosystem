// prepare-review, sync-base and finish-sync: their replies, review diffs and
// the branch on origin, run through the ops CLI against a local origin. None
// of them calls gh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { okLine, opsFixture, opsSourceDefines } from "./ops-fixture.mjs";
import { pushRecord } from "./push-record-test-kit.mjs";

const fx = await opsFixture("sync-ops");
const { fakeGh, originRef, sh, worktree } = fx;
const BASE = "origin/integration";
const WIKI_HEADING =
  "\n\n# Wiki changes (paths under wiki/; pushed to the wiki when the PR merges)\n\n";

// Runs an op, asserting it makes no gh calls; returns its stdout.
function ask(request, config) {
  fakeGh.reply([]);
  const out = fx.ask(request, config);
  assert.deepEqual(fakeGh.calls(), []);
  return out;
}

function gitIn(dir, args) {
  return sh(`git -C ${dir} ${args}`);
}

// A diff exactly as git prints it, untrimmed.
function patch(dir, range) {
  const args = ["-C", dir, "diff", "--stat", "--patch", range];
  return spawnSync("git", args, { encoding: "utf8" }).stdout;
}

// What prepare-review should reply and write for the diff `from..HEAD`.
function review(n, from, tag, wiki = { diff: "", files: [] }) {
  const wt = worktree(n);
  const headSha = gitIn(wt, "rev-parse HEAD");
  const baseSha = gitIn(wt, `merge-base ${BASE} HEAD`);
  const code = patch(wt, `${from ?? baseSha}..${headSha}`);
  let file = code;
  if (wiki.diff !== "") {
    file = `${code}${WIKI_HEADING}${wiki.diff}`;
  }
  const names = gitIn(wt, `diff --name-only ${baseSha}..${headSha}`);
  const diffPath = path.join(fx.root, "runs", "o__r", `issue-${n}`, `review-${tag}`, "diff.patch");
  const changedFiles = names.split("\n").concat(wiki.files);
  const diffLines = file.split("\n").length;
  return { file, reply: { headSha, baseSha, diffPath, diffLines, changedFiles } };
}

function assertReview(out, want) {
  assert.equal(out, okLine("prepare-review", want.reply));
  assert.equal(fs.readFileSync(want.reply.diffPath, "utf8"), want.file);
}

test("the sync ops live in src/ops/sync.ts", async () => {
  const { syncOps } = await import("../src/ops/sync.ts");
  const names = ["prepare-review", "sync-base", "finish-sync"];
  assert.deepEqual(Object.keys(syncOps), names);
  for (const name of names) {
    assert.equal(opsSourceDefines(name), false, name);
  }
});

test("prepare-review diffs the branch from its merge base", () => {
  fx.startBranch(21, "g", "one");
  fx.commitIn(21, "h", "two");
  fx.advanceBase("b21", "base");
  const out = ask({ op: "prepare-review", number: 21 });
  const want = review(21, undefined, "r0");
  assert.deepEqual(want.reply.changedFiles, ["g", "h"]);
  assertReview(out, want);
});

test("prepare-review diffs from sinceSha while it is in the branch", () => {
  const since = fx.startBranch(22, "g", "one");
  fx.commitIn(22, "h", "two");
  const out = ask({ op: "prepare-review", number: 22, sinceSha: since, tag: "r2" });
  const want = review(22, since, "r2");
  assert.ok(want.file.includes("+two"));
  assert.ok(!want.file.includes("+one"));
  assertReview(out, want);
});

test("prepare-review falls back to the merge base when sinceSha was rebased away", () => {
  fx.startBranch(23, "g", "one");
  const since = fx.commitIn(23, "h", "two");
  gitIn(worktree(23), "commit -q --amend -m reworded");
  const out = ask({ op: "prepare-review", number: 23, sinceSha: since });
  assertReview(out, review(23, undefined, "r0"));
});

test("prepare-review appends the issue's wiki commits", () => {
  const wikiOrigin = path.join(fx.root, "wiki.git");
  const seed = path.join(fx.root, "wiki-seed");
  sh(`git init -q --bare -b master ${wikiOrigin} && git clone -q ${wikiOrigin} ${seed} 2>/dev/null`);
  sh(`cd ${seed} && git config user.email a@b && git config user.name a`);
  sh(`cd ${seed} && echo home > Home.md && git add . && git commit -qm home && git push -q origin HEAD:master`);
  const config = fx.configWith("wiki-config.json", { wiki: { url: wikiOrigin } });
  fx.startBranch(24, "g", "one");
  const wiki = path.join(worktree(24), "wiki");
  sh(`git clone -q ${wikiOrigin} ${wiki} && cd ${wiki} && git config user.email a@b && git config user.name a`);
  sh(`cd ${wiki} && echo page > Page.md && git add . && git commit -qm page`);
  const out = ask({ op: "prepare-review", number: 24 }, config);
  const diff = patch(wiki, "origin/master...HEAD");
  const want = review(24, undefined, "r0", { diff, files: ["wiki/Page.md"] });
  assert.deepEqual(want.reply.changedFiles, ["g", "wiki/Page.md"]);
  assertReview(out, want);
});

function syncLine(reply) {
  return okLine("sync-base", reply);
}

test("sync-base leaves an up-to-date branch alone", () => {
  const headSha = fx.startBranch(31, "g", "one");
  const out = ask({ op: "sync-base", number: 31 });
  assert.equal(out, syncLine({ changed: false, conflict: false, headSha }));
  assert.equal(originRef("agent/issue-31"), headSha);
});

test("sync-base rebases onto a moved base and pushes", () => {
  const before = fx.startBranch(32, "g", "one");
  const base = fx.advanceBase("b32", "base");
  const out = ask({ op: "sync-base", number: 32 });
  const headSha = originRef("agent/issue-32");
  assert.notEqual(headSha, before);
  assert.equal(out, syncLine({ changed: true, conflict: false, headSha }));
  assert.equal(originRef(`${headSha}^`), base);
  const record = { sha: headSha, op: "sync-base", dated: true };
  assert.deepEqual(pushRecord(fx.root, 32), record);
});

test("sync-base whose push origin refuses goes back to its old head", () => {
  const before = fx.startBranch(33, "g", "one");
  fx.advanceBase("b33", "base");
  const hook = path.join(fx.root, "origin.git", "hooks", "pre-receive");
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  let out = "";
  try {
    out = ask({ op: "sync-base", number: 33 });
  } finally {
    fs.rmSync(hook);
  }
  assert.equal(JSON.parse(out).ok, false);
  assert.equal(originRef("agent/issue-33"), before);
  assert.deepEqual(fx.worktreeState(33), { head: before, status: "" });
});

// A branch whose file `c<n>` conflicts with the same file added on the base.
function conflicting(n) {
  const headSha = fx.startBranch(n, `c${n}`, "mine");
  const baseSha = fx.advanceBase(`c${n}`, "theirs");
  return { headSha, baseSha };
}

function conflictLine(n, inRebase, baseSha) {
  const conflicts = [`c${n}`];
  return syncLine({ changed: false, conflict: true, inRebase, conflicts, baseSha });
}

test("sync-base reports a conflict and aborts the rebase", () => {
  const { headSha, baseSha } = conflicting(33);
  const out = ask({ op: "sync-base", number: 33 });
  assert.equal(out, conflictLine(33, false, baseSha));
  assert.equal(fx.inRebase(33), false);
  assert.deepEqual(fx.worktreeState(33), { head: headSha, status: "" });
  assert.equal(originRef("agent/issue-33"), headSha);
});

test("sync-base keeps a conflicting rebase, and resets it on the next run", () => {
  const { headSha, baseSha } = conflicting(34);
  const kept = ask({ op: "sync-base", number: 34, keepConflict: true });
  assert.equal(kept, conflictLine(34, true, baseSha));
  assert.equal(fx.inRebase(34), true);
  const again = ask({ op: "sync-base", number: 34, keepConflict: false });
  assert.equal(again, conflictLine(34, false, baseSha));
  assert.equal(fx.inRebase(34), false);
  assert.deepEqual(fx.worktreeState(34), { head: headSha, status: "" });
});

// A conflicting rebase kept in the worktree for a writer, as sync-base leaves it.
function keptConflict(n) {
  const { headSha } = conflicting(n);
  ask({ op: "sync-base", number: n, keepConflict: true });
  return headSha;
}

function finishLine(reply) {
  return okLine("finish-sync", reply);
}

// Runs finish-sync expecting `reason`, and checks the worktree was reset.
function assertFails(n, request, reason, headSha = originRef(`agent/issue-${n}`)) {
  const out = ask({ op: "finish-sync", number: n, ...request });
  assert.equal(out, finishLine({ resolved: false, reason }));
  assert.equal(fx.inRebase(n), false);
  assert.deepEqual(fx.worktreeState(n), { head: headSha, status: "" });
  assert.equal(originRef(`agent/issue-${n}`), headSha);
}

test("finish-sync resets the worktree on an abort or an unfinished rebase", () => {
  assertFails(41, {}, "the rebase was not finished", keptConflict(41));
  const head = keptConflict(42);
  assertFails(42, { abort: true }, "aborted", head);
  keptConflict(43);
  assertFails(43, { abort: true, reason: "no time left" }, "no time left");
});

test("finish-sync refuses a worktree with uncommitted changes", () => {
  fx.startBranch(44, "g", "one");
  const names = Array.from({ length: 21 }, (_, at) => `u${String(at + 1).padStart(2, "0")}`);
  for (const name of names) {
    fs.writeFileSync(path.join(worktree(44), name), "x\n");
  }
  const lines = names.slice(1).map((name) => `?? ${name}`);
  const reason = `the worktree has uncommitted changes:\n${lines.join("\n")}`;
  assertFails(44, {}, reason);
});

test("finish-sync refuses a branch not on the base", () => {
  fx.startBranch(45, "g", "one");
  fx.advanceBase("b45", "base");
  fx.fetchClone();
  assertFails(45, {}, `HEAD is not based on ${BASE}`);
});

test("finish-sync refuses a branch with no commits left", () => {
  keptConflict(46);
  gitIn(worktree(46), "rebase --abort");
  gitIn(worktree(46), `reset -q --hard ${BASE}`);
  assertFails(46, {}, "the branch has no commits left after the rebase");
});

test("finish-sync refuses conflict markers", () => {
  const markers = [];
  for (let round = 0; round < 4; round += 1) {
    markers.push("<<<<<<< ours", "=======", ">>>>>>> theirs");
  }
  fx.startBranch(47, "m", ["<<<<<<<x", ...markers, "======= no"].join("\n"));
  const shown = markers.slice(0, 10).map((line) => `+${line}`);
  assertFails(47, {}, `conflict markers remain:\n${shown.join("\n")}`);
});

test("finish-sync pushes a finished rebase", () => {
  keptConflict(48);
  const wt = worktree(48);
  fs.writeFileSync(path.join(wt, "c48"), "resolved\n");
  sh(`cd ${wt} && git add c48 && GIT_EDITOR=true git rebase --continue`);
  const out = ask({ op: "finish-sync", number: 48 });
  const headSha = originRef("agent/issue-48");
  assert.equal(out, finishLine({ resolved: true, headSha }));
  assert.equal(gitIn(wt, "rev-parse HEAD"), headSha);
  assert.equal(originRef(`${headSha}^`), originRef("integration"));
  const record = { sha: headSha, op: "finish-sync", dated: true };
  assert.deepEqual(pushRecord(fx.root, 48), record);
});
