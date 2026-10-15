// The cleanup op at the end of a sweep: it removes a closed, unclaimed
// issue's worktree, branch and teardown resources once all its work is on
// GitHub, and keeps it, saying why, in every other case.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ask,
  assertReply,
  calls,
  claimListing,
  fakeGh,
  GIT_USER,
  sh,
  stateListing,
  world,
} from "./ops-test-kit.mjs";

const ISSUE = 7;
const CLOSED = { when: "--jq {state}", stdout: '{"state":"closed"}' };
const OPEN = { when: "--jq {state}", stdout: '{"state":"open"}' };
const MERGED_STATE = stateListing(ISSUE, { pr: 50, stage: "done" });

// world() with a teardown that leaves a marker file under the test root.
function cleanupWorld() {
  const w = world();
  const config = JSON.parse(fs.readFileSync(w.config, "utf8"));
  const marker = path.join(w.root, "torn-down");
  const commands = { ...config.commands, teardown: `touch ${marker}` };
  fs.writeFileSync(w.config, JSON.stringify({ ...config, commands }));
  return { ...w, marker };
}

// The worktree's head reaches GitHub only as PR #50's head, as after a
// squash merge that deleted the branch.
function pushAsPullHead(w) {
  sh(`git -C ${w.worktree} push -q origin HEAD:refs/pull/50/head`);
}

function cleanupReply(worktrees) {
  return { ok: true, op: "cleanup", posted: 0, worktrees };
}

function kept(why) {
  return cleanupReply([{ issue: ISSUE, outcome: "kept", why }]);
}

function branchExists(w) {
  const clone = path.join(w.root, "clones/o__r");
  const args = [
    "-C",
    clone,
    "rev-parse",
    "--verify",
    "--quiet",
    "agent/issue-7",
  ];
  return spawnSync("git", args).status === 0;
}

function assertKept(w) {
  assert.equal(fs.existsSync(w.worktree), true);
  assert.equal(branchExists(w), true);
  assert.equal(fs.existsSync(w.marker), false);
}

test("a closed issue whose work is on GitHub is removed and torn down", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  fakeGh.reply([CLOSED, MERGED_STATE]);
  const reply = ask(w, { op: "cleanup", skip: null });
  assertReply(reply, cleanupReply([{ issue: ISSUE, outcome: "removed" }]));
  assert.equal(fs.existsSync(w.worktree), false);
  assert.equal(fs.existsSync(w.marker), true);
  assert.equal(branchExists(w), false);
});

test("a closed issue with commits not on GitHub is kept", () => {
  const w = cleanupWorld();
  fakeGh.reply([CLOSED]);
  const reply = ask(w, { op: "cleanup" });
  assertReply(reply, kept("1 local commit is not on GitHub"));
  assertKept(w);
});

test("a closed issue with a PR and commits made after its head is kept", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  sh(`git -C ${w.worktree} ${GIT_USER} commit -q --allow-empty -m later`);
  fakeGh.reply([CLOSED, MERGED_STATE]);
  const reply = ask(w, { op: "cleanup" });
  assertReply(reply, kept("1 local commit is not on GitHub"));
  assertKept(w);
});

test("an open stopped issue is kept", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  fakeGh.reply([OPEN, MERGED_STATE]);
  assertReply(ask(w, { op: "cleanup" }), kept("the issue is open"));
  assertKept(w);
});

test("a closed issue with a live claim is kept", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  fakeGh.reply([CLOSED, claimListing()]);
  const reply = ask(w, { op: "cleanup" });
  assertReply(reply, kept("a live claim is held by lane L"));
  assertKept(w);
});

test("a closed issue with uncommitted changes is kept", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  fs.writeFileSync(path.join(w.worktree, "notes.txt"), "draft\n");
  fakeGh.reply([CLOSED, MERGED_STATE]);
  const reply = ask(w, { op: "cleanup" });
  assertReply(
    reply,
    kept("the worktree has uncommitted changes:\n?? notes.txt"),
  );
  assertKept(w);
});

test("a closed issue with wiki commits not on the wiki is kept", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  const clone = path.join(w.root, "clones/o__r.wiki");
  const dir = path.join(w.worktree, "wiki");
  const config = JSON.parse(fs.readFileSync(w.config, "utf8"));
  fs.writeFileSync(w.config, JSON.stringify({ ...config, wiki: true }));
  sh(
    `cd ${w.root} && git init -q --bare -b master wiki.git && git clone -q wiki.git ${clone} 2>/dev/null && git -C ${clone} ${GIT_USER} commit -q --allow-empty -m home && git -C ${clone} push -q origin HEAD:master`,
  );
  sh(
    `git -C ${clone} worktree add -q -b agent/issue-7 ${dir} origin/master && git -C ${dir} ${GIT_USER} commit -q --allow-empty -m page`,
  );
  // ensureWiki hides the wiki checkout from the code repo the same way.
  const exclude = path.join(w.root, "clones/o__r/.git/info/exclude");
  fs.appendFileSync(exclude, "\n/wiki/\n");
  fakeGh.reply([CLOSED, MERGED_STATE]);
  const reply = ask(w, { op: "cleanup" });
  assertReply(reply, kept("the wiki checkout has 1 commit(s) not on the wiki"));
  assertKept(w);
});

test("the sweep's own issue is kept without asking GitHub", () => {
  const w = cleanupWorld();
  pushAsPullHead(w);
  fakeGh.reply([CLOSED, MERGED_STATE]);
  const reply = ask(w, { op: "cleanup", skip: ISSUE });
  assertReply(reply, kept("this sweep's issue"));
  assert.deepEqual(calls(), []);
  assertKept(w);
});
