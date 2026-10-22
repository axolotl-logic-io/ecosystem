// @ts-check
// The leftover worktree of a submodule that a rebase removed
// (src/retired-submodules.ts): what is removed, and what stays.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { git } from "./job-git-test-kit.mjs";

const { removeRetiredSubmodules } = await import(
  "../src/retired-submodules.ts"
);

/** @returns {string} a fresh git checkout under the test's root */
function checkout() {
  const wt = fs.mkdtempSync(path.join(isolatedRoot, "rebase-"));
  git(["init", "-q", wt]);
  return wt;
}

// Local submodule URLs need the file protocol, which git refuses by default.
const FILE_PROTOCOL = ["-c", "protocol.file.allow=always"];
// `git status --porcelain` showing the leftover wiki folder.
const UNTRACKED_WIKI = /^\?\? wiki\/$/mu;

/** @returns {string} a fresh repository with one commit, to be a submodule */
function submoduleOrigin() {
  const sub = fs.mkdtempSync(path.join(isolatedRoot, "wiki-"));
  git(["init", "-q", "-b", "main", sub]);
  fs.writeFileSync(path.join(sub, "Home.md"), "home\n");
  git(["-C", sub, "add", "Home.md"]);
  git(["-C", sub, "commit", "-q", "-m", "Home"]);
  return sub;
}

/** @returns {string} a submodule origin that has a submodule of its own */
function withNestedSubmodule() {
  const sub = submoduleOrigin();
  git([
    ...FILE_PROTOCOL,
    "-C",
    sub,
    "submodule",
    "add",
    "-q",
    submoduleOrigin(),
    "nested",
  ]);
  git(["-C", sub, "commit", "-q", "-m", "Add a nested submodule"]);
  return sub;
}

/**
 * A repository whose `integration` adds a `wiki` submodule, then removes it,
 * and whose `issue` branch adds a file on top of the commit that added it.
 * @param {string} [origin] the submodule's origin
 * @returns {{ repo: string, from: string }} the repository and the `issue` head
 */
function historyRemovingSubmodule(origin = submoduleOrigin()) {
  const repo = checkout();
  git(["-C", repo, "checkout", "-q", "-b", "integration"]);
  git([...FILE_PROTOCOL, "-C", repo, "submodule", "add", "-q", origin, "wiki"]);
  git(["-C", repo, "commit", "-q", "-m", "Add the wiki"]);
  git(["-C", repo, "checkout", "-q", "-b", "issue"]);
  fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
  git(["-C", repo, "add", "feature.txt"]);
  git(["-C", repo, "commit", "-q", "-m", "Feature"]);
  const from = git(["-C", repo, "rev-parse", "HEAD"]);
  git(["-C", repo, "checkout", "-q", "integration"]);
  git(["-C", repo, "rm", "-q", "wiki"]);
  git(["-C", repo, "commit", "-q", "-m", "Move the wiki out"]);
  return { repo, from };
}

/**
 * Checks out `issue` in `wt`, initializes its submodule and rebases it onto
 * `integration`, which leaves `wiki/` untracked.
 * @param {string} wt
 * @returns {void}
 */
function rebaseIssue(wt) {
  git(["-C", wt, "checkout", "-q", "issue"]);
  git([
    ...FILE_PROTOCOL,
    "-C",
    wt,
    "submodule",
    "update",
    "-q",
    "--init",
    "--recursive",
  ]);
  git(["-C", wt, "rebase", "-q", "integration"]);
}

/** @returns {{ wt: string, from: string }} a checkout rebased past the removal, and its head before */
function rebasedPastRemovedSubmodule() {
  const { repo, from } = historyRemovingSubmodule();
  rebaseIssue(repo);
  return { wt: repo, from };
}

test("a finished rebase past a removed submodule drops its clean leftover worktree and keeps its repository", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
  assert.deepEqual(removeRetiredSubmodules(wt, from), ["wiki"]);
  assert.equal(git(["-C", wt, "status", "--porcelain"]), "");
  assert.ok(fs.existsSync(path.join(wt, ".git", "modules", "wiki")));
});

test("a linked worktree's leftover submodule worktree is dropped, and its repository stays", () => {
  const { repo, from } = historyRemovingSubmodule();
  git(["-C", repo, "checkout", "-q", "--detach"]);
  const wt = path.join(
    fs.mkdtempSync(path.join(isolatedRoot, "linked-")),
    "wt",
  );
  git(["-C", repo, "worktree", "add", "-q", wt, "integration"]);
  rebaseIssue(wt);
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
  assert.deepEqual(removeRetiredSubmodules(wt, from), ["wiki"]);
  assert.equal(git(["-C", wt, "status", "--porcelain"]), "");
  const modules = git(["-C", wt, "rev-parse", "--git-path", "modules"]);
  assert.ok(fs.existsSync(path.resolve(wt, modules, "wiki")));
});

test("a leftover submodule worktree holding an untracked file stays, and the checkout stays dirty", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  fs.writeFileSync(path.join(wt, "wiki", "Draft.md"), "draft\n");
  assert.deepEqual(removeRetiredSubmodules(wt, from), []);
  assert.ok(fs.existsSync(path.join(wt, "wiki", "Draft.md")));
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
});

test("a leftover submodule worktree holding an ignored file stays", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  const wiki = path.join(wt, "wiki");
  const exclude = git(["-C", wiki, "rev-parse", "--git-path", "info/exclude"]);
  fs.mkdirSync(path.dirname(path.resolve(wiki, exclude)), { recursive: true });
  fs.writeFileSync(path.resolve(wiki, exclude), "Draft.md\n");
  fs.writeFileSync(path.join(wiki, "Draft.md"), "draft\n");
  assert.equal(git(["-C", wiki, "status", "--porcelain"]), "");
  assert.deepEqual(removeRetiredSubmodules(wt, from), []);
  assert.ok(fs.existsSync(path.join(wiki, "Draft.md")));
});

test("a leftover submodule worktree holding a nested submodule stays", () => {
  const { repo, from } = historyRemovingSubmodule(withNestedSubmodule());
  rebaseIssue(repo);
  const wiki = path.join(repo, "wiki");
  assert.equal(git(["-C", wiki, "status", "--porcelain", "--ignored"]), "");
  assert.deepEqual(removeRetiredSubmodules(repo, from), []);
  assert.ok(fs.existsSync(path.join(wiki, "nested", "Home.md")));
});

test("a submodule that HEAD still has is left alone", () => {
  const { repo, from } = historyRemovingSubmodule();
  git(["-C", repo, "checkout", "-q", "issue"]);
  git([...FILE_PROTOCOL, "-C", repo, "submodule", "update", "-q", "--init"]);
  assert.deepEqual(removeRetiredSubmodules(repo, from), []);
  assert.ok(fs.existsSync(path.join(repo, "wiki", "Home.md")));
});
