// Reads of git's state in the repo's clone and the issues' worktrees: their
// heads, whether they are clean, and how an issue's branch compares with
// GitHub. They run git and gh but touch no files themselves, so they need no
// Node API.

import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { git } from "./github.ts";
import { withCloneLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import type { RunOptions, RunResult } from "./process.ts";
import { run, runFailure } from "./process.ts";
import { tail } from "./shell-command.ts";

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

function refExists(dir: string, ref: string): boolean {
  const args = ["-C", dir, "rev-parse", "--verify", "--quiet", ref];
  return run("git", args, { allowFail: true }).code === 0;
}

// How many of the issue's local commits GitHub has nowhere: not on the base,
// the issue's branch, or its PR's head, which keeps a squash-merged PR's
// commits after the branch is deleted.
function commitsOffGitHub(cfg: Config, n: number, pr: number | null): number {
  const clone = paths.clone(cfg);
  const branch = paths.branch(cfg, n);
  const base = cfg.baseBranch;
  const refspecs = [`+refs/heads/${base}:refs/remotes/origin/${base}`];
  if (remoteHead(cfg, n) !== null) {
    refspecs.push(`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  }
  if (pr !== null) {
    refspecs.push(`+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`);
  }
  const fetched = refspecs.map((refspec) => refspec.split(":")[1] ?? "");
  fetchIn(cfg, clone, ...refspecs);
  const heads = [head(paths.worktree(cfg, n))];
  if (refExists(clone, `refs/heads/${branch}`)) {
    heads.push(`refs/heads/${branch}`);
  }
  const known = fetched.filter((ref) => refExists(clone, ref));
  const args = ["rev-list", "--count", ...heads, "--not", ...known];
  return Number(gitIn(clone, args).trim());
}

// True when the issue's branch changes files against the base branch, so it
// holds work and not only start-pr's empty commit.
function branchHasWork(cfg: Config, n: number, remote: string): boolean {
  const clone = paths.clone(cfg);
  const branch = paths.branch(cfg, n);
  const base = cfg.baseBranch;
  fetchIn(
    cfg,
    clone,
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    `+refs/heads/${base}:refs/remotes/origin/${base}`,
  );
  const args = ["diff", "--quiet", `origin/${base}...${remote}`];
  const result = run("git", ["-C", clone, ...args], { allowFail: true });
  if (result.code > 1) {
    throw new OpsError(runFailure("git", args, result));
  }
  return result.code === 1;
}

// The patch id of the changes `head` makes against its merge base with
// `from` (`git patch-id --verbatim`, so a whitespace edit changes it), or
// null when it can't be computed: no merge base, an empty diff, or a git
// failure. A rebase that leaves those changes as they were keeps the id.
function patchIdOf(dir: string, from: string, tip: string): string | null {
  const options: RunOptions = { allowFail: true };
  const base = run("git", ["-C", dir, "merge-base", from, tip], options);
  const mergeBase = base.stdout.trim();
  if (base.code !== 0 || mergeBase === "") {
    return null;
  }
  const diffArgs = ["-C", dir, "diff", "--binary", mergeBase, tip];
  const diff = run("git", diffArgs, options);
  if (diff.code !== 0 || diff.stdout === "") {
    return null;
  }
  const idArgs = ["-C", dir, "patch-id", "--verbatim"];
  const ids = run("git", idArgs, { ...options, input: diff.stdout });
  const [id] = ids.stdout.trim().split(WHITESPACE);
  if (ids.code !== 0 || id === undefined || id === "") {
    return null;
  }
  return id;
}

export {
  assertClean,
  branchHasWork,
  commitsOffGitHub,
  fetchIn,
  gitIn,
  head,
  patchIdOf,
  remoteHead,
  uncommitted,
};
