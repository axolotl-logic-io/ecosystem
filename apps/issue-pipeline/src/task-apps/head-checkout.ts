// A task run's own checkout of one exact commit of the issue's branch, for
// work that only reads it, such as Verify's. It is a fresh clone from the
// pipeline's freshly fetched mirror, detached at the commit, in a folder
// no other run shares, and commits and pushes from it are refused. The run
// removes it once its work is done. A run that fails keeps it, so a
// person can see what it ran on.
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gitIn } from "../git-state.ts";
import { openJobCheckout } from "../job/checkout.ts";
import { OpsError } from "../ops-error.ts";

interface HeadCheckout {
  // The run's folder, its name, which says where it is without a local
  // path, and the clone in it.
  root: string;
  folder: string;
  repo: string;
  head: string;
}

// Opens task run `run`'s checkout of issue `issue` at exactly `head`.
function openHeadCheckout(
  cfg: Config,
  issue: number,
  job: { task: string; run: string; head: string },
): HeadCheckout {
  const dirs = openJobCheckout(cfg, issue, {
    stage: `${job.task}-${job.run}`,
    branch: paths.branch(cfg, issue),
  });
  try {
    gitIn(dirs.repo, ["checkout", "--quiet", "--detach", job.head]);
  } catch (error: unknown) {
    throw new OpsError(
      `the mirror of ${cfg.repo} doesn't have ${job.head}; its checkout is kept in ${path.basename(dirs.root)}`,
      { cause: error },
    );
  }
  return {
    root: dirs.root,
    folder: path.basename(dirs.root),
    repo: dirs.repo,
    head: job.head,
  };
}

// The checkout's head and every changed or untracked file, so a caller can
// tell whether something changed it in between.
function checkoutState(checkout: HeadCheckout): string {
  const now = gitIn(checkout.repo, ["rev-parse", "HEAD"]).trim();
  const changed = gitIn(checkout.repo, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]).trim();
  return [now, changed].join("\n");
}

// The tracked files that differ from the checkout's head, one per line, or
// "" when none does.
function trackedChanges(checkout: HeadCheckout): string {
  return gitIn(checkout.repo, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]).trim();
}

// The commit `ref` names in the checkout.
function commitOf(checkout: HeadCheckout, ref: string): string {
  return gitIn(checkout.repo, [
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]).trim();
}

function removeHeadCheckout(checkout: HeadCheckout): void {
  fs.rmSync(checkout.root, { recursive: true, force: true });
}

export type { HeadCheckout };
export {
  checkoutState,
  commitOf,
  openHeadCheckout,
  removeHeadCheckout,
  trackedChanges,
};
