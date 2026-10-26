// Reads of git's state in the repo's clone and the issues' worktrees: their
// heads, whether they are clean, and how an issue's branch compares with
// GitHub. They run git and gh but touch no files themselves, so they need no
// Node API.

import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { git } from "./github.ts";
import { withCloneLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import type { RunResult } from "./process.ts";
import { run, tail } from "./process.ts";

const STATUS_LINES = 20;
const WHITESPACE = /\s+/u;

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// A fetch writes refs shared by every worktree of the clone, so it takes the
// lock too.
function fetchIn(cfg: Config, dir: string, ...refs: string[]): RunResult {
  return withCloneLock(cfg, () =>
    git(cfg, "dev", ["-C", dir, "fetch", "origin", ...refs]),
  );
}

// The issue branch's head on GitHub, or null when it has none.
function remoteHead(cfg: Config, number: number): string | null {
  const ref = `refs/heads/${paths.branch(cfg, number)}`;
  const listed = git(cfg, "dev", [
    "-C",
    paths.clone(cfg),
    "ls-remote",
    "origin",
    ref,
  ]);
  const [sha] = listed.stdout.trim().split(WHITESPACE);
  return sha || null;
}

function head(wt: string): string {
  return gitIn(wt, ["rev-parse", "HEAD"]).trim();
}

// Why the checkout at `dir` (named `what`) isn't clean, or null when it is.
function uncommitted(dir: string, what: string): string | null {
  const status = gitIn(dir, ["status", "--porcelain"]).trim();
  if (status === "") {
    return null;
  }
  return `${what} has uncommitted changes:\n${tail(status, STATUS_LINES)}`;
}

function assertClean(dir: string, what = "worktree"): void {
  const reason = uncommitted(dir, what);
  if (reason !== null) {
    throw new OpsError(reason);
  }
}

export { assertClean, fetchIn, gitIn, head, remoteHead, uncommitted };
