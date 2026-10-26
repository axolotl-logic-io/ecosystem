// Repository clone and issue worktrees. Only deterministic ops push commits.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { configureClone, updateSubmodules } from "./clone-setup.ts";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { assertClean, fetchIn, gitIn, head } from "./git-state.ts";
import { git } from "./github.ts";
import { assertCheckoutReady, withCheckoutSetup } from "./lane-slots.ts";
import { withCloneLock } from "./locks.ts";
import { OpsError } from "./ops-error.ts";
import { run, runFailure, shell } from "./process.ts";
import { readWriteAuthority } from "./write-authority.ts";

const PUSHED_FILE = "pushed.json";
const MS_PER_MINUTE = 60_000;
// The config keys setUpCheckout reads; loadConfig applied their defaults.
const SETUP_SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({ setup: z.string().nullish() }),
});

// What an issue's work changes: whether its code branch changes files
// against the base branch.
interface BranchChanges {
  codeChanged: boolean;
}

// The code head after a push, and what the work changes.
interface PushResult extends BranchChanges {
  headSha: string;
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

// Records in the issue's run directory that `op` is pushing `sha` as the
// branch's head, replacing the last record, so a later claim on this machine
// knows that head as the pipeline's own push.
function recordPush(cfg: Config, n: number, sha: string, op: string): void {
  const dir = paths.runDir(cfg, n);
  fs.mkdirSync(dir, { recursive: true });
  const record = { sha, op, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, PUSHED_FILE), `${JSON.stringify(record)}\n`);
}

// What the issue's work changes: whether its branch changes files against the
// base branch.
function branchChanges(cfg: Config, n: number): BranchChanges {
  const wt = paths.worktree(cfg, n);
  const args = ["diff", "--quiet", `origin/${cfg.baseBranch}...HEAD`];
  const result = run("git", ["-C", wt, ...args], { allowFail: true });
  if (result.code > 1) {
    throw new OpsError(runFailure("git", args, result));
  }
  return { codeChanged: result.code === 1 };
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
  // The push record lets the next claim adopt the head (adopt-push.ts).
  git(
    cfg,
    "dev",
    ["-C", wt, "push", "--force-with-lease", "-u", "origin", target],
    { reconciles: true },
  );
  return headSha;
}

// Pushes the issue's branch for `op`, recording the push first, and returns
// the code head and what the work changes. allowEmpty lets start-pr push the
// branch's empty first commit. Otherwise a branch that changes no files is
// not pushed.
function push(
  cfg: Config,
  number: number,
  op: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): PushResult {
  const wt = paths.worktree(cfg, number);
  assertClean(wt, "worktree");
  const base = `origin/${cfg.baseBranch}`;
  const ahead = Number(
    gitIn(wt, ["rev-list", "--count", `${base}..HEAD`]).trim(),
  );
  if (!(ahead > 0)) {
    throw new OpsError("branch has no commits ahead of the base branch");
  }
  const changes = branchChanges(cfg, number);
  if (allowEmpty !== true && !changes.codeChanged) {
    return { headSha: head(wt), ...changes };
  }
  const headSha = pushHead(cfg, number, op);
  return { headSha, ...changes };
}

// Claims action `action`'s one setup start in issue `n`'s run folder, durably
// and exclusively, before its setup runs; false when it was claimed before.
// The marker only refuses a replay; it grants no readiness.
function claimSetupStart(cfg: Config, n: number, action: string): boolean {
  const dir = paths.runDir(cfg, n);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, `setup-${action}.started`);
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error: unknown) {
    if (fs.existsSync(marker)) {
      return false;
    }
    throw error;
  }
}

// Runs configured setup in the issue checkout with its leased environment.
// Logs output to logName. Any nonzero exit throws, with or without
// laneSlots: a failed setup never counts as prepared. With laneSlots its
// pending-setup barrier also stays in the lane store.
function setUpCheckout(
  cfg: Config,
  n: number,
  dir: string,
  logName: string,
): void {
  const { commandTimeoutMinutes, commands } = SETUP_SETTINGS.parse(cfg);
  const { setup } = commands;
  if (setup === undefined || setup === null || setup === "") {
    assertCheckoutReady(cfg, n, dir);
    return;
  }
  const log = path.join(paths.runDir(cfg, n), logName);
  const result = withCheckoutSetup(cfg, n, dir, (env) =>
    shell(setup, dir, log, {
      timeoutMs: commandTimeoutMinutes * MS_PER_MINUTE,
      env,
    }),
  );
  if (result.code !== 0) {
    throw new OpsError(
      `#${n} setup failed (exit ${result.code}); its checkout is not prepared`,
    );
  }
}

export type { BranchChanges, PushResult };
export {
  branchChanges,
  claimSetupStart,
  ensureClone,
  push,
  pushHead,
  recordPush,
  setUpCheckout,
};
