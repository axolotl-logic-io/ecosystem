// The leftover worktree of a submodule that a finished rebase removed: git
// leaves the folder behind as untracked files, which fail the finish check
// and no session may clean (sync-base, finish-sync).

import fs from "node:fs";
import path from "node:path";
import { run } from "./process.ts";
import { rebaseInProgress } from "./rebase.ts";

const GITLINK = /^160000 commit [0-9a-f]+\t(?<file>[\s\S]+)$/u;

function gitOut(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// Whether a `.git` entry exists anywhere below `dir`, other than its own:
// a nested repository whose work a recursive removal could lose.
function holdsNestedRepository(dir: string): boolean {
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  return entries.some(
    (entry) => entry.name === ".git" && entry.parentPath !== dir,
  );
}

// Whether `dir` is a submodule worktree that is safe to remove: a real
// folder whose `.git` file points into this checkout's own `modules/` folder,
// with no nested repository and nothing untracked, ignored or uncommitted.
function cleanModuleWorktree(wt: string, dir: string): boolean {
  const gitfile = path.join(dir, ".git");
  if (!(fs.lstatSync(dir).isDirectory() && fs.existsSync(gitfile))) {
    return false;
  }
  const modules = path.resolve(
    wt,
    gitOut(wt, ["rev-parse", "--git-path", "modules"]).trim(),
  );
  if (!(fs.lstatSync(gitfile).isFile() && fs.existsSync(modules))) {
    return false;
  }
  const own = fs.realpathSync(
    gitOut(dir, ["rev-parse", "--absolute-git-dir"]).trim(),
  );
  if (!own.startsWith(`${fs.realpathSync(modules)}${path.sep}`)) {
    return false;
  }
  if (holdsNestedRepository(dir)) {
    return false;
  }
  const status = [
    "status",
    "--porcelain",
    "--ignored",
    "--untracked-files=all",
  ];
  return gitOut(dir, status).trim() === "";
}

// The gitlink paths in commit `rev`'s tree.
function gitlinks(wt: string, rev: string): string[] {
  return gitOut(wt, ["ls-tree", "-r", "-z", rev])
    .split("\0")
    .map((entry) => {
      const { file } = GITLINK.exec(entry)?.groups ?? {};
      return file;
    })
    .filter((file): file is string => file !== undefined);
}

// Whether `file` was a submodule that HEAD no longer has, with a leftover
// worktree that is safe to remove (cleanModuleWorktree).
function retiredWorktree(wt: string, file: string): boolean {
  const dir = path.join(wt, file);
  const tracked = gitOut(wt, ["ls-tree", "HEAD", "--", file]).trim();
  return tracked === "" && fs.existsSync(dir) && cleanModuleWorktree(wt, dir);
}

// Removes the worktree of each submodule that `from` had and the finished
// rebase's HEAD no longer has. A rebase onto a base that removed a submodule
// leaves its folder behind as untracked residue, which no session may clean.
// Only a worktree that cleanModuleWorktree finds safe is removed; its
// repository, with any stash or unpushed commit, stays in `modules/`.
// Anything else stays and fails the cleanliness check.
function removeRetiredSubmodules(wt: string, from: string): string[] {
  if (rebaseInProgress(wt)) {
    return [];
  }
  const retired = gitlinks(wt, from).filter((file) =>
    retiredWorktree(wt, file),
  );
  for (const file of retired) {
    fs.rmSync(path.join(wt, file), { recursive: true, force: true });
  }
  return retired;
}

export { removeRetiredSubmodules };
