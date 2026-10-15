// The repo's clone and each issue's worktree and branch on this machine. One
// clone per repo; agents work in worktrees of it and only commit, and only the
// ops CLI pushes.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { git } from "./github.ts";
import { withCloneLock, withWikiLock } from "./locks.ts";
import type { RunResult } from "./process.ts";
import { OpsError, run, runFailure, shell, tail } from "./process.ts";

const CREDENTIAL_HELPER = "credential.https://github.com.helper";
const GH_HELPER: readonly string[] = [
  "-c",
  `${CREDENTIAL_HELPER}=`,
  "-c",
  `${CREDENTIAL_HELPER}=!gh auth git-credential`,
];
const PRE_PUSH_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_OPS" = 1 ] || { echo "Only the issue pipeline ops tool may push from this clone." >&2; exit 1; }\n';
const HOOK_MODE = 0o755;
const TEARDOWN_TIMEOUT_MS = 300_000;
const STATUS_LINES = 20;
const WHITESPACE = /\s+/u;
const ISSUE_DIR = /^issue-(?<n>\d+)$/u;
const PUSHED_FILE = "pushed.json";
// The part of the push record a claim reads.
const PUSHED = z.object({ sha: z.string(), op: z.string() });

// A head the pipeline pushed for an issue, and the op that pushed it.
interface PushRecord {
  sha: string;
  op: string;
}

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// Authenticates git through gh, using the token from the ops environment when
// there is one, and stops agents pushing by accident: only this tool pushes.
// (--no-verify bypasses the hook, so it is a guard, not a boundary.)
function configureClone(cfg: Config, clone: string): void {
  run("git", ["-C", clone, "config", "--unset-all", CREDENTIAL_HELPER], {
    allowFail: true,
  });
  gitIn(clone, ["config", "--add", CREDENTIAL_HELPER, ""]);
  gitIn(clone, [
    "config",
    "--add",
    CREDENTIAL_HELPER,
    "!gh auth git-credential",
  ]);
  gitIn(clone, ["config", "user.name", cfg.gitName || cfg.account]);
  const email = cfg.gitEmail || `${cfg.account}@users.noreply.github.com`;
  gitIn(clone, ["config", "user.email", email]);
  const hook = path.join(clone, ".git", "hooks", "pre-push");
  fs.writeFileSync(hook, PRE_PUSH_HOOK);
  fs.chmodSync(hook, HOOK_MODE);
}

// A fetch writes refs shared by every worktree of the clone, so it takes the
// lock too.
function fetchIn(cfg: Config, dir: string, ...refs: string[]): RunResult {
  return withCloneLock(cfg, () =>
    git(cfg, ["-C", dir, "fetch", "origin", ...refs]),
  );
}

function ensureClone(cfg: Config): string {
  return withCloneLock(cfg, () => {
    const clone = paths.clone(cfg);
    if (!fs.existsSync(path.join(clone, ".git"))) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
      git(cfg, [...GH_HELPER, "clone", url, clone]);
    }
    configureClone(cfg, clone);
    fetchIn(cfg, clone, "--prune");
    gitIn(clone, ["worktree", "prune"]);
    return clone;
  });
}

// The issue branch's head on GitHub, or null when it has none.
function remoteHead(cfg: Config, number: number): string | null {
  const ref = `refs/heads/${paths.branch(number)}`;
  const listed = git(cfg, ["-C", paths.clone(cfg), "ls-remote", "origin", ref]);
  const [sha] = listed.stdout.trim().split(WHITESPACE);
  return sha || null;
}

function ensureWorktree(cfg: Config, number: number): string {
  return withCloneLock(cfg, () => {
    const clone = paths.clone(cfg);
    const wt = paths.worktree(cfg, number);
    const branch = paths.branch(number);
    if (fs.existsSync(path.join(wt, ".git"))) {
      return wt;
    }
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    let start = `origin/${cfg.baseBranch}`;
    if (remoteHead(cfg, number) !== null) {
      const refspec = `${branch}:refs/remotes/origin/${branch}`;
      git(cfg, ["-C", clone, "fetch", "origin", refspec]);
      start = `origin/${branch}`;
    }
    gitIn(clone, ["worktree", "add", "-B", branch, wt, start]);
    return wt;
  });
}

function removeWikiCheckout(cfg: Config, number: number): void {
  const wikiClone = paths.wikiClone(cfg);
  if (wikiCfg(cfg) === null || !fs.existsSync(wikiClone)) {
    return;
  }
  withWikiLock(cfg, () => {
    for (const args of [
      ["worktree", "remove", "--force", paths.wiki(cfg, number)],
      ["worktree", "prune"],
      ["branch", "-D", paths.branch(number)],
    ]) {
      run("git", ["-C", wikiClone, ...args], { allowFail: true });
    }
  });
}

function removeWorktree(cfg: Config, number: number): void {
  // Frees what setup made outside the worktree, such as a per-issue test
  // database. Runs in the issue's run dir, whose path names the issue. A
  // failure is only logged.
  const { teardown } = cfg.commands;
  if (teardown !== undefined && teardown !== null && teardown !== "") {
    const dir = paths.runDir(cfg, number);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, "teardown.log");
    shell(teardown, dir, log, TEARDOWN_TIMEOUT_MS);
  }
  removeWikiCheckout(cfg, number);
  withCloneLock(cfg, () => {
    const clone = paths.clone(cfg);
    const wt = paths.worktree(cfg, number);
    if (fs.existsSync(wt)) {
      const args = ["-C", clone, "worktree", "remove", "--force", wt];
      run("git", args, { allowFail: true });
    }
    const branch = paths.branch(number);
    run("git", ["-C", clone, "branch", "-D", branch], { allowFail: true });
  });
}

function head(wt: string): string {
  return gitIn(wt, ["rev-parse", "HEAD"]).trim();
}

// The issues that have a worktree on this machine, in number order.
function issueWorktrees(cfg: Config): number[] {
  const dir = path.dirname(paths.worktree(cfg, 0));
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const { n } = ISSUE_DIR.exec(entry.name)?.groups ?? {};
      return n ?? [];
    })
    .map(Number)
    .sort((a, b) => a - b);
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
  const branch = paths.branch(n);
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

// Why the issue's worktree holds work that GitHub lacks (uncommitted changes,
// or commits on no branch or PR there), or null when it holds none. `pr` is
// the issue's PR, or null when it has none.
function unsavedWork(cfg: Config, n: number, pr: number | null): string | null {
  const wt = paths.worktree(cfg, n);
  if (!fs.existsSync(path.join(wt, ".git"))) {
    return "not a git worktree";
  }
  const dirty = uncommitted(wt, "the worktree");
  if (dirty !== null) {
    return dirty;
  }
  const count = withCloneLock(cfg, () => commitsOffGitHub(cfg, n, pr));
  if (count === 0) {
    return null;
  }
  if (count === 1) {
    return "1 local commit is not on GitHub";
  }
  return `${count} local commits are not on GitHub`;
}

// Records in the issue's run directory that `op` is pushing `sha` as the
// branch's head, replacing the last record, so a later claim on this machine
// knows that head as the pipeline's own push.
function recordPush(cfg: Config, n: number, sha: string, op: string): void {
  const dir = paths.runDir(cfg, n);
  fs.mkdirSync(dir, { recursive: true });
  const record = { sha, op, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, PUSHED_FILE), `${JSON.stringify(record)}\n`);
}

// The head this machine last recorded pushing for the issue and the op that
// pushed it, or null when it has no readable record.
function lastPush(cfg: Config, n: number): PushRecord | null {
  const file = path.join(paths.runDir(cfg, n), PUSHED_FILE);
  try {
    const { sha, op } = PUSHED.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    return { sha, op };
  } catch {
    return null;
  }
}

// Pushes the issue's branch for `op`, recording the push first, and returns
// its head. allowEmpty lets start-pr push the branch's empty first commit.
// Every other push must change files, since that commit alone puts the branch
// ahead of the base.
function push(
  cfg: Config,
  number: number,
  op: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  const wt = paths.worktree(cfg, number);
  assertClean(wt, "worktree");
  const wiki = paths.wiki(cfg, number);
  if (wikiCfg(cfg) !== null && fs.existsSync(path.join(wiki, ".git"))) {
    assertClean(wiki, "the wiki checkout");
  }
  const base = `origin/${cfg.baseBranch}`;
  const ahead = Number(
    gitIn(wt, ["rev-list", "--count", `${base}..HEAD`]).trim(),
  );
  if (!(ahead > 0)) {
    throw new OpsError("branch has no commits ahead of the base branch");
  }
  const diff = ["-C", wt, "diff", "--quiet", `${base}...HEAD`];
  if (allowEmpty !== true && run("git", diff, { allowFail: true }).code === 0) {
    throw new OpsError("branch changes no files against the base branch");
  }
  const target = `HEAD:refs/heads/${paths.branch(number)}`;
  recordPush(cfg, number, head(wt), op);
  git(cfg, ["-C", wt, "push", "--force-with-lease", "-u", "origin", target]);
  return head(wt);
}

// True when the issue's branch changes files against the base branch, so it
// holds work and not only start-pr's empty commit.
function branchHasWork(cfg: Config, n: number, remote: string): boolean {
  const clone = paths.clone(cfg);
  const branch = paths.branch(n);
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

export type { PushRecord };
export {
  assertClean,
  branchHasWork,
  configureClone,
  ensureClone,
  ensureWorktree,
  fetchIn,
  GH_HELPER,
  head,
  issueWorktrees,
  lastPush,
  push,
  recordPush,
  remoteHead,
  removeWorktree,
  uncommitted,
  unsavedWork,
};
