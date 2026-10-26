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
import { abortRebase, clearCodeSync } from "../rebase.ts";
import { readWriteAuthority } from "../write-authority.ts";

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
  // The push record and Sync's attempt reconcile it (sync-task-reconcile.ts).
  git(cfg, "dev", ["-C", wt, "push", "--force-with-lease", "origin", target], {
    reconciles: true,
  });
}

export { pushBranch, resetToRemote };
