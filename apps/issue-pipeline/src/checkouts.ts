// The repo's clone and each issue's worktree and branch on this machine. One
// Agents commit in worktrees; only deterministic ops push.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configureClone, updateSubmodules } from "./clone-setup.ts";
import type { Config } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import {
  assertClean,
  commitsOffGitHub,
  fetchIn,
  gitIn,
  head,
  remoteHead,
  uncommitted,
} from "./git-state.ts";
import { git } from "./github.ts";
import { withCloneLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import { run, runFailure, shell } from "./process.ts";
import { holdWikiPin, pushWikiBranch, wikiAhead } from "./wiki.ts";
import { readWriteAuthority } from "./write-authority.ts";

const TEARDOWN_TIMEOUT_MS = 300_000;
const ISSUE_DIR = /^issue-(?<n>\d+)$/u;
const PUSHED_FILE = "pushed.json";
const MS_PER_MINUTE = 60_000;
// The config keys setUpCheckout reads; loadConfig applied their defaults.
const SETUP_SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({ setup: z.string().nullish() }),
});
// The part of the push record a claim reads.
const PUSHED = z.object({ sha: z.string(), op: z.string() });

// What an issue's work changes: its code branch against the base branch, and
// the commits its wiki checkout has that the wiki lacks.
interface BranchChanges {
  codeChanged: boolean;
  wikiAhead: number;
}

// The code head after a push, and what the work changes.
interface PushResult extends BranchChanges {
  headSha: string;
}

// A head the pipeline pushed for an issue, and the op that pushed it.
interface PushRecord {
  sha: string;
  op: string;
}

function ensureClone(cfg: Config): string {
  return withCloneLock(cfg, () => {
    const clone = paths.clone(cfg);
    if (!fs.existsSync(path.join(clone, ".git"))) {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
      git(cfg, "dev", ["clone", url, clone]);
    }
    configureClone(cfg, clone);
    fetchIn(cfg, clone, "--prune");
    gitIn(clone, ["checkout", "--detach", `origin/${cfg.baseBranch}`]);
    gitIn(clone, ["worktree", "prune"]);
    updateSubmodules(cfg, clone);
    return clone;
  });
}

// Issue `number`'s worktree, made if it is missing: on its branch's head on
// GitHub, or with no branch there, on the base's.
function ensureWorktree(cfg: Config, number: number): string {
  return withCloneLock(cfg, () => {
    const clone = paths.clone(cfg);
    const wt = paths.worktree(cfg, number);
    const branch = paths.branch(cfg, number);
    if (fs.existsSync(path.join(wt, ".git"))) {
      return wt;
    }
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    let start = `origin/${cfg.baseBranch}`;
    if (remoteHead(cfg, number) !== null) {
      const refspec = `${branch}:refs/remotes/origin/${branch}`;
      git(cfg, "dev", ["-C", clone, "fetch", "origin", refspec]);
      start = `origin/${branch}`;
    }
    gitIn(clone, ["worktree", "add", "-B", branch, wt, start]);
    updateSubmodules(cfg, wt);
    return wt;
  });
}

// Runs the configured teardown for issue `number`, then removes its lane
// worktree and local branch. A stage job's own checkout (`cfg.checkout`) is
// never removed here: the job is still running in it, and closes it itself
// as it exits (job/teardown.ts), so the checkout that proves a completion
// stays until then.
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
  if (cfg.checkout?.issue === number) {
    return;
  }
  withCloneLock(cfg, () => {
    const clone = paths.clone(cfg);
    const wt = paths.worktree(cfg, number);
    if (fs.existsSync(wt)) {
      const args = [
        "-C",
        clone,
        "worktree",
        "remove",
        "--force",
        "--force",
        wt,
      ];
      run("git", args, { allowFail: true });
    }
    const branch = paths.branch(cfg, number);
    run("git", ["-C", clone, "branch", "-D", branch], { allowFail: true });
  });
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

// Why the issue's worktree holds work that GitHub lacks (uncommitted changes,
// or commits on no branch or PR there), or null when it holds none. `pr` is
// the issue's PR, or null when it has none.
function unsavedWork(cfg: Config, n: number, pr: number | null): string | null {
  const wt = paths.worktree(cfg, n);
  if (!fs.existsSync(path.join(wt, ".git"))) {
    return "not a git worktree";
  }
  // The wiki checkout's own work is unsavedWiki's to judge.
  holdWikiPin(cfg, wt);
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

// What the issue's work changes: whether its branch changes files against the
// base branch, and how many commits its wiki checkout has that the wiki lacks.
function branchChanges(cfg: Config, n: number): BranchChanges {
  const wt = paths.worktree(cfg, n);
  const args = ["diff", "--quiet", `origin/${cfg.baseBranch}...HEAD`];
  const result = run("git", ["-C", wt, ...args], { allowFail: true });
  if (result.code > 1) {
    throw new OpsError(runFailure("git", args, result));
  }
  return { codeChanged: result.code === 1, wikiAhead: wikiAhead(cfg, n) };
}

// Pushes the issue's checkout's HEAD to its branch for `op`, recording the
// push first, with --force-with-lease against the head it last pushed, and
// returns the head pushed. A refused push throws.
function pushHead(cfg: Config, n: number, op: string): string {
  const wt = paths.worktree(cfg, n);
  const headSha = head(wt);
  const target = `HEAD:refs/heads/${paths.branch(cfg, n)}`;
  if (!readWriteAuthority(cfg, n).codeWritable) {
    throw new OpsError(`#${n}'s code merged; refusing code push`);
  }
  recordPush(cfg, n, headSha, op);
  git(cfg, "dev", [
    "-C",
    wt,
    "push",
    "--force-with-lease",
    "-u",
    "origin",
    target,
  ]);
  return headSha;
}

// Pushes the issue's branch for `op`, recording the push first, and its wiki
// checkout's own commits to the wiki's branch of the same name, and returns
// the code head and what the work changes. allowEmpty lets start-pr push the
// branch's empty first commit. Otherwise a branch that changes no files is
// pushed only when the wiki has commits, and nothing is pushed when neither
// changed.
function push(
  cfg: Config,
  number: number,
  op: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): PushResult {
  const wt = paths.worktree(cfg, number);
  holdWikiPin(cfg, wt);
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
  const changes = branchChanges(cfg, number);
  if (allowEmpty !== true && !changes.codeChanged && changes.wikiAhead === 0) {
    return { headSha: head(wt), ...changes };
  }
  const headSha = pushHead(cfg, number, op);
  pushWikiBranch(cfg, number);
  return { headSha, ...changes };
}

// Runs the repo's setup command (config `commands.setup`), if it sets one,
// in issue `n`'s checkout `dir`, so the writer's own test runs get this
// issue's database and ports instead of the shared defaults. It writes the
// command's output to `logName` in the issue's run folder. A failure is only
// logged: verify runs setup again and reports it.
function setUpCheckout(
  cfg: Config,
  n: number,
  dir: string,
  logName: string,
): void {
  const { commandTimeoutMinutes, commands } = SETUP_SETTINGS.parse(cfg);
  const { setup } = commands;
  if (setup === undefined || setup === null || setup === "") {
    return;
  }
  const log = path.join(paths.runDir(cfg, n), logName);
  shell(setup, dir, log, commandTimeoutMinutes * MS_PER_MINUTE);
}

export type { BranchChanges, PushRecord, PushResult };
export {
  branchChanges,
  ensureClone,
  ensureWorktree,
  issueWorktrees,
  lastPush,
  push,
  pushHead,
  recordPush,
  removeWorktree,
  setUpCheckout,
  unsavedWork,
};
