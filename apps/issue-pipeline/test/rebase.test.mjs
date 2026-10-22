// @ts-check
// The code sync record (src/rebase.ts) a checkout keeps across a conflicted
// rebase: what it reads back from the git dir, and the removed-submodule
// residue a finished rebase leaves.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { git } from "./job-git-test-kit.mjs";

const { readCodeSync, removeRetiredSubmodules, saveCodeSync } = await import(
  "../src/rebase.ts"
);

// A SHA-1 commit id's hex length.
const SHA_LENGTH = 40;
const FROM = "a".repeat(SHA_LENGTH);
const ONTO = "b".repeat(SHA_LENGTH);

/** @returns {string} a fresh git checkout under the test's root */
function checkout() {
  const wt = fs.mkdtempSync(path.join(isolatedRoot, "rebase-"));
  git(["init", "-q", wt]);
  return wt;
}

test("a code sync record reads back as saved, and a checkout without one has none", () => {
  const wt = checkout();
  assert.equal(readCodeSync(wt), undefined);
  saveCodeSync(wt, { from: FROM, onto: ONTO });
  assert.deepEqual(readCodeSync(wt), { from: FROM, onto: ONTO });
});

test("a code sync record written while the pipeline had a wiki reads without its wiki flag", () => {
  const wt = checkout();
  const file = path.join(wt, ".git", "pipeline-code-sync.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ from: FROM, onto: ONTO, wikiResolved: true }),
  );
  assert.deepEqual(readCodeSync(wt), { from: FROM, onto: ONTO });
});

// Local submodule URLs need the file protocol, which git refuses by default.
const FILE_PROTOCOL = ["-c", "protocol.file.allow=always"];
// `git status --porcelain` showing the leftover wiki folder.
const UNTRACKED_WIKI = /^\?\? wiki\/$/mu;

/**
 * A checkout on a branch whose base later removed its `wiki` submodule,
 * rebased onto that base. Its `wiki/` folder is left untracked.
 * @returns {{ wt: string, from: string }} the checkout and the branch head before the rebase
 */
function rebasedPastRemovedSubmodule() {
  const sub = fs.mkdtempSync(path.join(isolatedRoot, "wiki-"));
  git(["init", "-q", "-b", "main", sub]);
  fs.writeFileSync(path.join(sub, "Home.md"), "home\n");
  git(["-C", sub, "add", "Home.md"]);
  git(["-C", sub, "commit", "-q", "-m", "Home"]);
  const wt = checkout();
  git(["-C", wt, "checkout", "-q", "-b", "integration"]);
  git([...FILE_PROTOCOL, "-C", wt, "submodule", "add", "-q", sub, "wiki"]);
  git(["-C", wt, "commit", "-q", "-m", "Add the wiki"]);
  git(["-C", wt, "checkout", "-q", "-b", "issue"]);
  fs.writeFileSync(path.join(wt, "feature.txt"), "feature\n");
  git(["-C", wt, "add", "feature.txt"]);
  git(["-C", wt, "commit", "-q", "-m", "Feature"]);
  const from = git(["-C", wt, "rev-parse", "HEAD"]);
  git(["-C", wt, "checkout", "-q", "integration"]);
  git(["-C", wt, "rm", "-q", "wiki"]);
  git(["-C", wt, "commit", "-q", "-m", "Move the wiki out"]);
  git(["-C", wt, "checkout", "-q", "issue"]);
  git([...FILE_PROTOCOL, "-C", wt, "submodule", "update", "-q", "--init"]);
  git(["-C", wt, "rebase", "-q", "integration"]);
  return { wt, from };
}

test("a finished rebase past a removed submodule drops its clean leftover worktree and keeps its repository", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
  assert.deepEqual(removeRetiredSubmodules(wt, from), ["wiki"]);
  assert.equal(git(["-C", wt, "status", "--porcelain"]), "");
  assert.ok(fs.existsSync(path.join(wt, ".git", "modules", "wiki")));
});

test("a leftover submodule worktree holding uncommitted work stays, and the checkout stays dirty", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  fs.writeFileSync(path.join(wt, "wiki", "Draft.md"), "draft\n");
  assert.deepEqual(removeRetiredSubmodules(wt, from), []);
  assert.ok(fs.existsSync(path.join(wt, "wiki", "Draft.md")));
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
});

test("a submodule the rebased branch still has is left alone", () => {
  const { wt } = rebasedPastRemovedSubmodule();
  const head = git(["-C", wt, "rev-parse", "HEAD"]);
  assert.deepEqual(removeRetiredSubmodules(wt, head), []);
  assert.ok(fs.existsSync(path.join(wt, "wiki", "Home.md")));
});
