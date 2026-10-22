// The leftover worktree of a submodule that a finished rebase removed: git
// leaves the folder behind as untracked files, which fail the finish check
// and no session may clean (sync-base, finish-sync). Proving such a folder
// disposable is unreliable (index flags, cached stat data, lossy filters), so
// it is never deleted: it is renamed, whole, into the issue's recovery folder.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { run } from "./process.ts";
import { rebaseInProgress } from "./rebase.ts";

const GITLINK = /^160000 commit [0-9a-f]+\t(?<file>[\s\S]+)$/u;

function gitOut(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
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

// Whether `file` was a submodule that HEAD no longer tracks, with a real
// folder left at its path inside the checkout: no component of the path is a
// symlink, so nothing outside the checkout moves.
function retiredFolder(wt: string, file: string): boolean {
  const dir = path.join(wt, file);
  const tracked = gitOut(wt, ["ls-tree", "HEAD", "--", file]).trim();
  if (tracked !== "" || !fs.existsSync(dir)) {
    return false;
  }
  const inside = path.join(fs.realpathSync(wt), file);
  return fs.lstatSync(dir).isDirectory() && fs.realpathSync(dir) === inside;
}

// Renames `from` to `to`. A rename keeps every byte, attribute and special
// file; a copy may not, so across filesystems nothing moves.
function renamed(from: string, to: string): boolean {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EXDEV") {
      return false;
    }
    throw error;
  }
}

// Moves the leftover folder of each submodule that `from` had and the
// finished rebase's HEAD no longer has into a new `retired-submodules-*`
// folder under `recovery`, keeping its relative path. Returns the paths
// moved; nothing is deleted. A folder that can't be renamed there (another
// filesystem) stays, and the finish check rejects the rebase as before.
function moveRetiredSubmodules(
  wt: string,
  from: string,
  recovery: string,
): string[] {
  if (rebaseInProgress(wt)) {
    return [];
  }
  const retired = gitlinks(wt, from).filter((file) => retiredFolder(wt, file));
  if (retired.length === 0) {
    return [];
  }
  fs.mkdirSync(recovery, { recursive: true });
  const into = fs.mkdtempSync(path.join(recovery, "retired-submodules-"));
  return retired.filter((file) =>
    renamed(path.join(wt, file), path.join(into, file)),
  );
}

// Moves issue `n`'s retired submodule folders in `wt` into its run folder's
// `recovery/` (moveRetiredSubmodules).
function retireSubmodules(
  cfg: Config,
  n: number,
  wt: string,
  from: string,
): string[] {
  const recovery = path.join(paths.runDir(cfg, n), "recovery");
  return moveRetiredSubmodules(wt, from, recovery);
}

export { moveRetiredSubmodules, retireSubmodules };
