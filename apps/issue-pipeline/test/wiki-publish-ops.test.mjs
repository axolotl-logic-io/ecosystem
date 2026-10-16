// @ts-check
// The wiki's rebase ops: wiki-sync rebases #7's wiki commits onto the wiki's
// master and keeps them on origin's agent/issue-7, leaving a conflict stopped
// for the resolver; finish-wiki-sync keeps a resolved rebase or resets a bad
// one; publish leaves a conflict stopped and the issue open, with no patch,
// rebases again after losing a push race, and pushes nothing with no commits.
// Both rebasing ops start over from a rebase a run before them left stopped.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ask,
  calls,
  fakeGh,
  finishReplies,
  GIT_USER,
  hoursFromNow,
  LANE,
  replyLine,
  SWEEP,
  sh,
  world,
} from "./ops-test-kit.mjs";
import { hasBranch, withWiki } from "./wiki-test-kit.mjs";

/** @import { World } from "./ops-test-kit.mjs" */

const ISSUE = 7;
const STATE = {
  pr: 50,
  stage: "publish",
  lease: { lane: LANE, sweepId: SWEEP, at: hoursFromNow(0) },
};

/** @param {World} w @returns {string} */
function wikiDir(w) {
  return path.join(w.worktree, "wiki");
}

/** @param {World} w @param {string} op @param {object} [fields] @returns {string} */
function runOp(w, op, fields = {}) {
  fakeGh.reply([]);
  return ask(w, { op, number: ISSUE, ...fields });
}

/** @param {string} op @param {object} reply @returns {string} */
function line(op, reply) {
  return replyLine({ ok: true, op, posted: 0, ...reply });
}

/** @param {string} origin @param {string} ref @returns {string} */
function revOf(origin, ref) {
  return sh(`git -C ${origin} rev-parse ${ref}`);
}

// Gives origin's master back Home.md's first line, so that the issue's edit
// rebases cleanly again.
/** @param {World} w @returns {void} */
function undoOtherEdit(w) {
  const other = path.join(w.root, "wiki-other");
  sh(
    `echo home > ${other}/Home.md && git -C ${other} ${GIT_USER} commit -q -am undo && git -C ${other} push -q origin HEAD:master`,
  );
}

/** @param {string} origin @returns {object} */
function conflictOf(origin) {
  return {
    conflict: true,
    inRebase: true,
    conflicts: ["Home.md"],
    baseSha: revOf(origin, "master"),
    branch: "master",
  };
}

test("wiki-sync with no wiki has nothing to rebase", () => {
  const w = world();
  const none = { conflict: false, changed: false, headSha: "" };
  assert.equal(runOp(w, "wiki-sync"), line("wiki-sync", none));
});

test("wiki-sync rebases onto a moved master and keeps the result on agent/issue-7", () => {
  const w = world();
  const wiki = withWiki(w);
  const other = path.join(w.root, "wiki-other");
  sh(
    `git clone -q ${wiki.origin} ${other} 2>/dev/null && echo more > ${other}/Other.md && git -C ${other} add Other.md && git -C ${other} ${GIT_USER} commit -q -m more && git -C ${other} push -q origin HEAD:master`,
  );
  const out = runOp(w, "wiki-sync");
  const headSha = sh(`git -C ${wikiDir(w)} rev-parse HEAD`);
  const synced = { conflict: false, changed: true, headSha };
  assert.equal(out, line("wiki-sync", synced));
  assert.equal(revOf(wiki.origin, "agent/issue-7"), headSha);
  assert.equal(revOf(wiki.origin, "master"), revOf(wikiDir(w), "HEAD~1"));
});

test("a wiki-sync conflict stops the rebase, and an unfinished one is reset", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  const out = runOp(w, "wiki-sync");
  assert.equal(out, line("wiki-sync", conflictOf(wiki.origin)));
  const finished = runOp(w, "finish-wiki-sync");
  const reason = "the rebase was not finished";
  assert.equal(finished, line("finish-wiki-sync", { resolved: false, reason }));
  assert.equal(revOf(wikiDir(w), "HEAD"), wiki.sha);
  assert.equal(sh(`git -C ${wikiDir(w)} status --porcelain`), "");
});

test("a resolved wiki rebase is kept on agent/issue-7", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  runOp(w, "wiki-sync");
  const dir = wikiDir(w);
  sh(
    `echo both > ${dir}/Home.md && git -C ${dir} add Home.md && GIT_EDITOR=true git -C ${dir} ${GIT_USER} rebase --continue`,
  );
  const headSha = revOf(dir, "HEAD");
  const finished = runOp(w, "finish-wiki-sync");
  assert.equal(finished, line("finish-wiki-sync", { resolved: true, headSha }));
  assert.equal(revOf(wiki.origin, "agent/issue-7"), headSha);
});

test("a publish conflict stops the rebase and leaves the issue open with no patch", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  const out = runOp(w, "publish", { state: STATE });
  const conflict = { published: false, ...conflictOf(wiki.origin) };
  assert.equal(out, line("publish", conflict));
  assert.deepEqual(calls(), []);
  assert.equal(hasBranch(wiki.origin, "agent/issue-7"), true);
  const runDir = path.join(w.root, "runs/o__r/issue-7");
  assert.equal(fs.existsSync(path.join(runDir, "wiki-unpushed.patch")), false);
  assert.equal(fs.existsSync(w.worktree), true);
});

test("wiki-sync starts over from a rebase an earlier wiki-sync left stopped", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  const conflict = line("wiki-sync", conflictOf(wiki.origin));
  assert.equal(runOp(w, "wiki-sync"), conflict);
  assert.equal(runOp(w, "wiki-sync"), conflict);
  undoOtherEdit(w);
  const out = runOp(w, "wiki-sync");
  const headSha = revOf(wikiDir(w), "HEAD");
  const synced = { conflict: false, changed: true, headSha };
  assert.equal(out, line("wiki-sync", synced));
  assert.equal(revOf(wiki.origin, "agent/issue-7"), headSha);
});

test("publish starts over from a rebase an earlier publish left stopped", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  const conflict = { published: false, ...conflictOf(wiki.origin) };
  assert.equal(
    runOp(w, "publish", { state: STATE }),
    line("publish", conflict),
  );
  assert.equal(
    runOp(w, "publish", { state: STATE }),
    line("publish", conflict),
  );
  undoOtherEdit(w);
  fakeGh.reply(finishReplies());
  const out = ask(w, { op: "publish", number: ISSUE, state: STATE });
  const sha = revOf(wiki.origin, "master");
  assert.equal(out, line("publish", { published: true, sha }));
  assert.equal(sh(`git -C ${wiki.origin} log -1 --format=%s master`), "page");
  assert.equal(hasBranch(wiki.origin, "agent/issue-7"), false);
});

const MARKERS_LEFT = /^conflict markers remain:\n/u;

// Makes the wiki origin refuse the first push to master, and move master on by
// a commit that adds Other.md as it does, as though another issue's publish
// won the race; later pushes go through. The hook leaves git's quarantine
// before it moves master, since git refuses ref updates inside it.
/** @param {World} w @param {string} origin @returns {string} */
function loseFirstPushRace(w, origin) {
  const other = path.join(w.root, "wiki-race");
  sh(
    `git clone -q ${origin} ${other} 2>/dev/null && echo race > ${other}/Other.md && git -C ${other} add Other.md && git -C ${other} ${GIT_USER} commit -q -m race`,
  );
  const raced = sh(`git -C ${other} rev-parse HEAD`);
  sh(`git -C ${other} push -q origin HEAD:refs/heads/race`);
  const lost = path.join(w.root, "race-lost");
  const hook = [
    "#!/bin/sh",
    `if [ -e ${lost} ]; then exit 0; fi`,
    `touch ${lost}`,
    `env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES git -C ${origin} update-ref refs/heads/master ${raced}`,
    "exit 1",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(origin, "hooks/pre-receive"), hook, {
    mode: 0o755,
  });
  return raced;
}

test("finish-wiki-sync rejects a resolution that leaves conflict markers, and resets", () => {
  const w = world();
  const wiki = withWiki(w, { conflict: true });
  runOp(w, "wiki-sync");
  const dir = wikiDir(w);
  sh(
    `git -C ${dir} add Home.md && GIT_EDITOR=true git -C ${dir} ${GIT_USER} rebase --continue`,
  );
  const reply = JSON.parse(runOp(w, "finish-wiki-sync"));
  assert.equal(reply.resolved, false);
  assert.match(reply.reason, MARKERS_LEFT);
  assert.equal(revOf(dir, "HEAD"), wiki.sha);
  assert.equal(revOf(wiki.origin, "agent/issue-7"), wiki.sha);
  assert.equal(sh(`git -C ${dir} status --porcelain`), "");
});

test("publish rebases again and pushes after losing a push race", () => {
  const w = world();
  const wiki = withWiki(w);
  const raced = loseFirstPushRace(w, wiki.origin);
  fakeGh.reply(finishReplies());
  const out = ask(w, { op: "publish", number: ISSUE, state: STATE });
  const sha = revOf(wiki.origin, "master");
  assert.equal(out, line("publish", { published: true, sha }));
  assert.equal(revOf(wiki.origin, "master~1"), raced);
  assert.equal(sh(`git -C ${wiki.origin} log -1 --format=%s master`), "page");
  assert.equal(fs.existsSync(path.join(w.root, "race-lost")), true);
  assert.equal(hasBranch(wiki.origin, "agent/issue-7"), false);
});

test("publish with no wiki commits of the issue's own pushes nothing", () => {
  const w = world();
  const wiki = withWiki(w);
  const master = revOf(wiki.origin, "master");
  sh(`git -C ${wikiDir(w)} reset -q --hard origin/master`);
  fakeGh.reply(finishReplies());
  const out = ask(w, { op: "publish", number: ISSUE, state: STATE });
  assert.equal(out, line("publish", { published: true, sha: null }));
  assert.equal(revOf(wiki.origin, "master"), master);
});
