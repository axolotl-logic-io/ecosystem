// @ts-check
// The leftover worktree of a submodule that a rebase removed
// (src/retired-submodules.ts): it moves, whole, into the recovery folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { git } from "./job-git-test-kit.mjs";

const { moveRetiredSubmodules } = await import("../src/retired-submodules.ts");

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
// The folder a move creates under the recovery folder.
const RETIRED_FOLDER = /^retired-submodules-/u;

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

/** @returns {string} a fresh recovery folder under the test's root */
function recoveryFolder() {
  return path.join(fs.mkdtempSync(path.join(isolatedRoot, "run-")), "recovery");
}

/**
 * The `retired-submodules-*` folders in `recovery`.
 * @param {string} recovery
 * @returns {string[]}
 */
function retiredFolders(recovery) {
  return fs
    .readdirSync(recovery)
    .filter((name) => RETIRED_FOLDER.test(name))
    .map((name) => path.join(recovery, name));
}

test("a finished rebase past a removed submodule moves its leftover folder into recovery, and the checkout is clean", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  const recovery = recoveryFolder();
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
  assert.deepEqual(moveRetiredSubmodules(wt, from, recovery), ["wiki"]);
  assert.equal(git(["-C", wt, "status", "--porcelain"]), "");
  assert.equal(retiredFolders(recovery).length, 1);
  const kept = path.join(retiredFolders(recovery)[0] ?? "", "wiki");
  assert.equal(fs.readFileSync(path.join(kept, "Home.md"), "utf8"), "home\n");
  assert.ok(fs.existsSync(path.join(wt, ".git", "modules", "wiki")));
});

test("a linked worktree's leftover submodule folder moves into recovery", () => {
  const { repo, from } = historyRemovingSubmodule();
  git(["-C", repo, "checkout", "-q", "--detach"]);
  const wt = path.join(
    fs.mkdtempSync(path.join(isolatedRoot, "linked-")),
    "wt",
  );
  git(["-C", repo, "worktree", "add", "-q", wt, "integration"]);
  rebaseIssue(wt);
  const recovery = recoveryFolder();
  assert.deepEqual(moveRetiredSubmodules(wt, from, recovery), ["wiki"]);
  assert.equal(git(["-C", wt, "status", "--porcelain"]), "");
  assert.ok(
    fs.existsSync(
      path.join(retiredFolders(recovery)[0] ?? "", "wiki", "Home.md"),
    ),
  );
});

test("every byte of a leftover folder survives the move, whatever git status reports", () => {
  const { repo, from } = historyRemovingSubmodule(withNestedSubmodule());
  git(["-C", repo, "checkout", "-q", "issue"]);
  git([
    ...FILE_PROTOCOL,
    "-C",
    repo,
    "submodule",
    "update",
    "-q",
    "--init",
    "--recursive",
  ]);
  const wiki = path.join(repo, "wiki");
  git(["-C", wiki, "update-index", "--assume-unchanged", "Home.md"]);
  fs.writeFileSync(path.join(wiki, "Home.md"), "hidden draft\n");
  fs.writeFileSync(path.join(wiki, "Untracked.md"), "untracked\n");
  fs.writeFileSync(path.join(wiki, "nested", "Nested.md"), "nested\n");
  git(["-C", repo, "rebase", "-q", "integration"]);
  const recovery = recoveryFolder();
  assert.deepEqual(moveRetiredSubmodules(repo, from, recovery), ["wiki"]);
  const kept = path.join(retiredFolders(recovery)[0] ?? "", "wiki");
  assert.equal(
    fs.readFileSync(path.join(kept, "Home.md"), "utf8"),
    "hidden draft\n",
  );
  assert.equal(
    fs.readFileSync(path.join(kept, "Untracked.md"), "utf8"),
    "untracked\n",
  );
  assert.equal(
    fs.readFileSync(path.join(kept, "nested/Nested.md"), "utf8"),
    "nested\n",
  );
  assert.ok(fs.existsSync(path.join(kept, "nested", ".git")));
});

test("a symlink left at a retired submodule's path is not moved or followed", () => {
  const { repo, from } = historyRemovingSubmodule();
  git(["-C", repo, "checkout", "-q", "issue"]);
  git(["-C", repo, "rebase", "-q", "integration"]);
  const outside = fs.mkdtempSync(path.join(isolatedRoot, "outside-"));
  fs.rmSync(path.join(repo, "wiki"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(repo, "wiki"));
  const recovery = recoveryFolder();
  assert.deepEqual(moveRetiredSubmodules(repo, from, recovery), []);
  assert.ok(fs.lstatSync(path.join(repo, "wiki")).isSymbolicLink());
  assert.equal(fs.existsSync(recovery), false);
});

test("a submodule that HEAD still has is left alone", () => {
  const { repo, from } = historyRemovingSubmodule();
  git(["-C", repo, "checkout", "-q", "issue"]);
  git([...FILE_PROTOCOL, "-C", repo, "submodule", "update", "-q", "--init"]);
  const recovery = recoveryFolder();
  assert.deepEqual(moveRetiredSubmodules(repo, from, recovery), []);
  assert.ok(fs.existsSync(path.join(repo, "wiki", "Home.md")));
  assert.equal(fs.existsSync(recovery), false);
});
