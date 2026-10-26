// Verify's full checks: the configured checks on exactly the bound head, in a
// fresh detached checkout of the shared clone that no branch or push can
// reach. They never commit, rebase, push or write a PR. Tracked changes the
// checks leave are evidence: their patch and checkout are retained, and the
// checks don't count.
//
// A setup that fails or does not finish never counts as checked: its
// detached checkout is retained whole, with or without laneSlots, and with
// laneSlots its pending-setup barrier stays registered on the issue's lease.
// The checks then throw, so the action ends unknown and holds the issue,
// rather than recording a result from an environment that was never
// prepared.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gitIn } from "../git-state.ts";
import { withCloneLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import { run as runCommand } from "../process.ts";
import { changedFiles, runChecks } from "./checks.ts";
import type { OpenRun } from "./task-run.ts";

// What the checks found on the head: each check's outcome, whether all
// passed, and the retained checkout when they changed tracked files.
interface Checked {
  checks: { id: string; pass: boolean }[];
  pass: boolean;
  retained: string | null;
}

function revisionOf(run: OpenRun): { code: string; target: string } {
  if (!("revision" in run.binding)) {
    throw new OpsError("a Verify binding binds a revision");
  }
  return {
    code: run.binding.revision.code,
    target: run.binding.target.commit,
  };
}

function removeCheckout(cfg: Config, clone: string, parent: string): void {
  const dir = path.join(parent, "repo");
  withCloneLock(cfg, () => {
    runCommand("git", ["-C", clone, "worktree", "remove", "--force", dir], {
      allowFail: true,
    });
    runCommand("git", ["-C", clone, "worktree", "prune"], { allowFail: true });
  });
  fs.rmSync(parent, { recursive: true, force: true });
}

// Where the head's change starts: its merge base with the target, since
// the head need not contain the target yet.
function changeBase(dir: string, target: string, code: string): string {
  const base = runCommand("git", ["-C", dir, "merge-base", target, code], {
    allowFail: true,
  });
  if (base.code !== 0) {
    return target;
  }
  return base.stdout.trim();
}

// Runs the configured checks on the run's head.
function checkedAt(run: OpenRun): Checked {
  const { cfg, number, evidence } = run;
  const { code, target } = revisionOf(run);
  fs.mkdirSync(paths.runDir(cfg, number), { recursive: true });
  const parent = fs.mkdtempSync(
    path.join(paths.runDir(cfg, number), "verify-checkout-"),
  );
  const dir = path.join(parent, "repo");
  withCloneLock(cfg, () =>
    gitIn(evidence.clone, ["worktree", "add", "--detach", dir, code]),
  );
  // The reason names only the folder: the action's end reaches the ledger,
  // which rewrites the local pipeline root.
  const retained = `its checkout is retained in ${path.basename(parent)} in the issue's run folder`;
  let reply: ReturnType<typeof runChecks>;
  try {
    reply = runChecks(cfg, number, {
      dir,
      sha: code,
      changed: changedFiles(dir, changeBase(dir, target, code), code),
      keepTracked: true,
    });
  } catch (error: unknown) {
    throw new OpsError(`Verify's checks did not finish; ${retained}`, {
      cause: error,
    });
  }
  if (reply.checks.some((check) => check.id === "setup" && !check.pass)) {
    throw new OpsError(`Verify's setup failed; ${retained}`);
  }
  const checks = reply.checks.map(({ id, pass }) => ({ id, pass }));
  const tracked = gitIn(dir, ["status", "--porcelain", "--untracked-files=no"]);
  if (tracked.trim() !== "") {
    fs.writeFileSync(
      path.join(parent, "tracked.patch"),
      gitIn(dir, ["diff", "--binary", "HEAD"]),
    );
    return { checks, pass: false, retained: parent };
  }
  removeCheckout(cfg, evidence.clone, parent);
  return { checks, pass: reply.pass, retained: null };
}

export type { Checked };
export { changeBase, checkedAt };
