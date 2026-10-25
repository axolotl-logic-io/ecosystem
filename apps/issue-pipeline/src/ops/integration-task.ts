// Integrate's effect (`integrate-task`), on the v2 records: for this
// action's own recorded Integrate attempt, its prerequisites again, then the
// configured checks on revision R in a fresh detached checkout of the
// shared clone that no branch or push can reach. It never commits, rebases,
// pushes or writes a PR. Tracked changes the checks leave are evidence:
// their patch and checkout are retained, and the run fails. R, T, inputs or
// policy moving during the checks fails the run, whose result would no
// longer be current.
//
// A setup that fails or does not finish never counts as checked: its
// detached checkout is retained whole, with or without laneSlots, and with
// laneSlots its pending-setup barrier stays registered on the issue's lease.
// The op then fails, so the action ends unknown and holds the issue, rather
// than recording a result from an environment that was never prepared.

import fs from "node:fs";
import path from "node:path";
import { ensureClone } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gitIn } from "../git-state.ts";
import { withCloneLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import { run as runCommand } from "../process.ts";
import { unsupportedTeardown } from "../runtime/preparation.ts";
import { MODULES } from "../tasks/modules.ts";
import { taskEvidence } from "../tasks/view.ts";
import { changedFiles, runChecks } from "./checks.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openRun, settled } from "./task-run.ts";

interface Checked {
  checks: { id: string; pass: boolean }[];
  pass: boolean;
  retained: string | null;
}

function revisionOf(run: OpenRun): { code: string; target: string } {
  if (!("revision" in run.binding)) {
    return { code: "", target: "" };
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

function checkedAt(run: OpenRun): Checked {
  const { cfg, number, evidence } = run;
  const { code, target } = revisionOf(run);
  fs.mkdirSync(paths.runDir(cfg, number), { recursive: true });
  const parent = fs.mkdtempSync(
    path.join(paths.runDir(cfg, number), "integrate-"),
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
      changed: changedFiles(dir, target, code),
      keepTracked: true,
    });
  } catch (error: unknown) {
    throw new OpsError(`Integrate's checks did not finish; ${retained}`, {
      cause: error,
    });
  }
  if (reply.checks.some((check) => check.id === "setup" && !check.pass)) {
    throw new OpsError(`Integrate's setup failed; ${retained}`);
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

// Why the run's result would not be current after the checks, or null.
function moved(run: OpenRun): string | null {
  const now = taskEvidence(run.cfg, run.number, ensureClone(run.cfg));
  return MODULES.integrate.prerequisite(run.cfg, now, run.binding);
}

function outcomeOf(run: OpenRun, checked: Checked): EffectOutcome {
  const { code, target } = revisionOf(run);
  if (checked.retained !== null) {
    return {
      verdict: "failed",
      reason: `the checks changed tracked files; their checkout and patch are retained in ${checked.retained}`,
    };
  }
  const stale = moved(run);
  if (stale !== null) {
    return { verdict: "failed", reason: `moved during the checks: ${stale}` };
  }
  if (!checked.pass) {
    const failing = checked.checks.filter((check) => !check.pass);
    return {
      verdict: "failed",
      reason: `checks failed on ${code}: ${failing.map((check) => check.id).join(", ")}`,
    };
  }
  return {
    verdict: "passed",
    reason: `every check passed on ${code} at ${target}`,
  };
}

function integrateTask(cfg: Config, request: unknown): EffectOutcome {
  const run = openRun(cfg, request, "integrate", "integrate-task");
  const teardown = unsupportedTeardown(
    cfg,
    MODULES.integrate.definition,
    "act",
  );
  if (teardown !== null) {
    throw new OpsError(`integrate-task refused: ${teardown}`);
  }
  const unmet = MODULES.integrate.prerequisite(cfg, run.evidence, run.binding);
  if (unmet !== null) {
    return settled(run, {
      verdict: "failed",
      reason: `nothing checked: ${unmet}`,
    });
  }
  const checked = checkedAt(run);
  return settled(run, outcomeOf(run, checked), {
    checks: checked.checks,
    retained: checked.retained,
  });
}

export { integrateTask };
