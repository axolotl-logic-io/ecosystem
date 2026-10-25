// The leftover worktree of a submodule that a rebase removed
// (src/retired-submodules.ts): it moves, whole, into the recovery folder.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mock, test } from "node:test";
import { isolatedRoot } from "./isolated-root-test-kit.ts";
import { git } from "./job-git-test-kit.ts";

const { moveRetiredSubmodules }: typeof import("../src/retired-submodules.ts") =
  await import("../src/retired-submodules.ts");

// Returns a fresh git checkout under the test's root
function checkout(): string {
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

// Returns a fresh repository with one commit, to be a submodule
function submoduleOrigin(): string {
  const sub = fs.mkdtempSync(path.join(isolatedRoot, "wiki-"));
  git(["init", "-q", "-b", "main", sub]);
  fs.writeFileSync(path.join(sub, "Home.md"), "home\n");
  git(["-C", sub, "add", "Home.md"]);
  git(["-C", sub, "commit", "-q", "-m", "Home"]);
  return sub;
}

// Returns a submodule origin that has a submodule of its own
function withNestedSubmodule(): string {
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

// A repository whose `integration` adds a `wiki` submodule, then removes it,
// and whose `issue` branch adds a file on top of the commit that added it.
// origin: the submodule's origin
// Returns the repository and the `issue` head
function historyRemovingSubmodule(origin: string = submoduleOrigin()): {
  repo: string;
  from: string;
} {
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

// Checks out `issue` in `wt`, initializes its submodule and rebases it onto
// `integration`, which leaves `wiki/` untracked.
function rebaseIssue(wt: string): void {
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

// Returns a checkout rebased past the removal, and its head before
function rebasedPastRemovedSubmodule(): { wt: string; from: string } {
  const { repo, from } = historyRemovingSubmodule();
  rebaseIssue(repo);
  return { wt: repo, from };
}

// Returns a fresh recovery folder under the test's root
function recoveryFolder(): string {
  return path.join(fs.mkdtempSync(path.join(isolatedRoot, "run-")), "recovery");
}

// The `retired-submodules-*` folders in `recovery`.
function retiredFolders(recovery: string): string[] {
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

test("a retired submodule under a symlinked folder is not moved, and the folder outside stays", () => {
  const repo = checkout();
  git([
    ...FILE_PROTOCOL,
    "-C",
    repo,
    "submodule",
    "add",
    "-q",
    submoduleOrigin(),
    "docs/wiki",
  ]);
  git(["-C", repo, "commit", "-q", "-m", "Add the wiki under docs"]);
  const from = git(["-C", repo, "rev-parse", "HEAD"]);
  git(["-C", repo, "rm", "-q", "docs/wiki"]);
  const outside = fs.mkdtempSync(path.join(isolatedRoot, "outside-"));
  fs.mkdirSync(path.join(outside, "wiki"));
  fs.writeFileSync(path.join(outside, "wiki", "Draft.md"), "draft\n");
  fs.rmSync(path.join(repo, "docs"), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(repo, "docs"));
  git(["-C", repo, "add", "docs"]);
  git(["-C", repo, "commit", "-q", "-m", "Link docs elsewhere"]);
  const recovery = recoveryFolder();
  assert.deepEqual(moveRetiredSubmodules(repo, from, recovery), []);
  assert.equal(
    fs.readFileSync(path.join(outside, "wiki", "Draft.md"), "utf8"),
    "draft\n",
  );
});

test("a leftover folder on another filesystem from recovery stays where it is", () => {
  const { wt, from } = rebasedPastRemovedSubmodule();
  const recovery = recoveryFolder();
  mock.method(fs, "renameSync", () => {
    throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  });
  try {
    assert.deepEqual(moveRetiredSubmodules(wt, from, recovery), []);
  } finally {
    mock.restoreAll();
  }
  assert.ok(fs.existsSync(path.join(wt, "wiki", "Home.md")));
  assert.match(git(["-C", wt, "status", "--porcelain"]), UNTRACKED_WIKI);
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
