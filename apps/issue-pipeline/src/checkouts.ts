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
const PUSHED = z.looseObject({
  sha: z.string(),
  op: z.string(),
  run: z.string().nullish(),
});
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

// What the issue's last recorded push was: the head, the op that pushed it
// and the task run it pushed for, when it named one.
interface PushRecord {
  sha: string;
  op: string;
  run: string | null;
}

// Records in the issue's run directory that `pushed.op` is pushing
// `pushed.sha` as the branch's head for task run `pushed.run`, replacing the
// last record, so a later claim or reconciliation on this machine knows
// that head as the pipeline's own push.
function recordPush(cfg: Config, n: number, pushed: PushRecord): void {
  const dir = paths.runDir(cfg, n);
  fs.mkdirSync(dir, { recursive: true });
  const record = { ...pushed, at: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, PUSHED_FILE), `${JSON.stringify(record)}\n`);
}

// The issue's last recorded push on this machine, or null when none was
// recorded or the record can't be read: no record proves no push.
function lastPush(cfg: Config, n: number): PushRecord | null {
  const file = path.join(paths.runDir(cfg, n), PUSHED_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const record = PUSHED.safeParse(parsed);
  if (!record.success) {
    return null;
  }
  const { sha, op } = record.data;
  return { sha, op, run: record.data.run ?? null };
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

// A push the remote refused because its branch holds commits this checkout
// lacks: another worker's work. Nothing was overwritten, and this checkout's
// HEAD is on its own recovery branch.
class PushDiverged extends OpsError {
  readonly branch: string;
  readonly recovery: string;
  readonly headSha: string;

  constructor(branch: string, recovery: string, headSha: string) {
    super(
      `${branch} has commits this checkout doesn't contain, so nothing was overwritten; this checkout's work is on ${recovery} at ${headSha}`,
    );
    this.branch = branch;
    this.recovery = recovery;
    this.headSha = headSha;
  }
}

// What git prints when a branch moved to history the pushed head lacks.
const NOT_FAST_FORWARD =
  /\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)/u;
const RECOVERY_ID_LENGTH = 12;

// The branch that preserves one action's diverged work: the item branch
// with the action's own id, or else its head commit. Two workers never
// share one, so neither replaces the other's.
function recoveryBranch(cfg: Config, branch: string, headSha: string): string {
  const id = cfg.execution?.instance ?? headSha;
  return `${branch}-recovery-${id.replaceAll("-", "").slice(0, RECOVERY_ID_LENGTH)}`;
}

// Pushes `wt`'s HEAD to `branch` without force; true when the remote
// refused it as a non-fast-forward. Any other failure throws.
function fastForward(cfg: Config, wt: string, branch: string): boolean {
  const args = ["-C", wt, "push", "origin", `HEAD:refs/heads/${branch}`];
  const result = git(cfg, "dev", args, { reconciles: true, allowFail: true });
  if (result.code === 0) {
    return false;
  }
  if (NOT_FAST_FORWARD.test(result.stderr)) {
    return true;
  }
  throw new OpsError(runFailure("git", args, result));
}

// Pushes the issue's checkout's HEAD to its branch for `op` of task run
// `taskRun`, recording the push first, and returns the head pushed. Pushes
// only fast-forward: when the branch holds commits this checkout lacks,
// another worker's, it publishes HEAD on its recovery branch instead and
// throws PushDiverged. No push replaces anyone's commits, and no timestamp
// picks a winner. Any other refused push throws.
function pushHead(
  cfg: Config,
  n: number,
  op: string,
  taskRun: string | null = null,
): string {
  const wt = paths.worktree(cfg, n);
  const headSha = head(wt);
  const branch = paths.branch(cfg, n);
  if (!readWriteAuthority(cfg, n).codeWritable) {
    throw new OpsError(`#${n}'s code merged; refusing code push`);
  }
  // Recorded before the push. A reader trusts the record only when the
  // remote branch is at exactly this head, so a push that went to a
  // recovery branch instead is never taken as the branch's own.
  recordPush(cfg, n, { sha: headSha, op, run: taskRun });
  if (fastForward(cfg, wt, branch)) {
    const recovery = recoveryBranch(cfg, branch, headSha);
    if (fastForward(cfg, wt, recovery)) {
      throw new OpsError(
        `${branch} and its recovery branch ${recovery} both hold other work; the checkout keeps ${headSha}`,
      );
    }
    throw new PushDiverged(branch, recovery, headSha);
  }
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

export type { BranchChanges, PushRecord, PushResult };
export {
  branchChanges,
  claimSetupStart,
  ensureClone,
  lastPush,
  PushDiverged,
  push,
  pushHead,
  recordPush,
  setUpCheckout,
};
