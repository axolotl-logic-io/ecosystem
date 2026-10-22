// What finish-sync checks a rebase a writer resolved against, before it
// pushes it, and the push and reset that sync-base and finish-sync share
// (sync.ts).

import { recordPush } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { head, remoteHead } from "../git-state.ts";
import { git } from "../github.ts";
import { saveSyncRecovery } from "../job/code-recovery.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import {
  abortRebase,
  clearCodeSync,
  readCodeSync,
  rebaseProblem,
} from "../rebase.ts";
import { removeRetiredSubmodules } from "../retired-submodules.ts";
import { readWriteAuthority } from "../write-authority.ts";

// The commit sync-base rebased onto (its reply's baseSha, #279).
interface FinishAgainst {
  baseSha?: string | null | undefined;
}

// What the resolved rebase in `wt` is checked against, or why it can't be.
// With a baseSha it is checked against that commit,
// which must be on the base, so a base that moved during the fix doesn't
// throw the resolution away.
function finishTarget(
  cfg: Config,
  wt: string,
  { baseSha }: FinishAgainst,
): { onto: string } | { problem: string } {
  const base = `origin/${cfg.baseBranch}`;
  if (baseSha === null || baseSha === undefined || baseSha === "") {
    return { onto: base };
  }
  const ancestor = ["-C", wt, "merge-base", "--is-ancestor", baseSha, base];
  if (run("git", ancestor, { allowFail: true }).code !== 0) {
    return { problem: `${baseSha} is not on ${base}` };
  }
  return { onto: baseSha };
}

// Why issue `n`'s resolved rebase can't be pushed, or undefined when it can:
// the rebase's own checks against its target (finishTarget).
function finishProblem(
  cfg: Config,
  n: number,
  against: FinishAgainst,
): string | undefined {
  const wt = paths.worktree(cfg, n);
  const sync = readCodeSync(wt);
  const target = finishTarget(cfg, wt, {
    baseSha: against.baseSha ?? sync?.onto,
  });
  if ("problem" in target) {
    return target.problem;
  }
  if (sync !== undefined) {
    removeRetiredSubmodules(wt, sync.from);
  }
  return rebaseProblem(wt, target.onto);
}

// Puts the worktree back on the pushed branch, dropping a half-done rebase.
function resetToRemote(cfg: Config, n: number, reason?: string): void {
  const wt = paths.worktree(cfg, n);
  saveSyncRecovery(cfg, n, wt, reason);
  abortRebase(wt);
  const remote = remoteHead(cfg, n);
  if (remote !== null) {
    run("git", ["-C", wt, "reset", "--hard", remote]);
  }
  run("git", ["-C", wt, "clean", "-fd"]);
  clearCodeSync(wt);
}

// Pushes the worktree's head as the issue's branch for `op`, recording the
// push first.
function pushBranch(cfg: Config, n: number, wt: string, op: string): void {
  const target = `HEAD:refs/heads/${paths.branch(cfg, n)}`;
  if (!readWriteAuthority(cfg, n).codeWritable) {
    throw new OpsError(`#${n}'s code merged; refusing sync push`);
  }
  recordPush(cfg, n, head(wt), op);
  git(cfg, "dev", ["-C", wt, "push", "--force-with-lease", "origin", target]);
}

export { finishProblem, pushBranch, resetToRemote };
