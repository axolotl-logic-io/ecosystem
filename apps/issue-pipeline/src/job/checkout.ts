// A stage job's own checkout of its issue (#250), in a folder no other job
// shares: `repo/`, a full clone with initialized submodules. Its origin is
// the real remote, and it is set up as the ops CLI sets up its clone.
// Closing it saves what it left uncommitted as patches in the issue's run
// folder, lets a writer push authorized commits, and bundles remaining
// local code for operator recovery before removal. Recovery failures retain the
// checkout; a later job never overwrites it. A task app's read-only session
// gets a detached checkout of the base instead, which holds nothing to save.

import fs from "node:fs";
import path from "node:path";
import {
  configureClone,
  guardCommits,
  updateSubmodules,
} from "../clone-setup.ts";
import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withCloneLock } from "../mirror-lock.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";

// A setup failure retains its checkout for explicit reconciliation.
class CheckoutSetupError extends OpsError {}

// A clone to make: the mirror it comes from, the remote its origin names, the
// base branch and the branch the issue's work is on.
interface CloneSpec {
  mirror: string;
  url: string;
  base: string;
  branch: string;
}

// A stage job's folder and its code checkout.
interface JobDirs {
  root: string;
  repo: string;
  // The issue branch the job's caller assigned, which the checkout is on.
  branch: string;
}

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

function hasRef(dir: string, ref: string): boolean {
  const args = ["-C", dir, "rev-parse", "--verify", "--quiet", ref];
  return run("git", args, { allowFail: true }).code === 0;
}

// Makes the bare mirror of `url` at `mirror` if missing, then fetches it.
function syncMirror(cfg: Config, mirror: string, url: string): void {
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const clone = ["clone", "--mirror", url, mirror];
    git(cfg, "dev", clone);
  }
  git(cfg, "dev", ["-C", mirror, "fetch", "origin", "--prune"]);
}

// Clones `spec.mirror` into `dir` on the issue's branch: at the mirror's
// branch head when it has one, and at the base otherwise. Only
// pipeline_commit and the ops commit there.
function cloneInto(cfg: Config, spec: CloneSpec, dir: string): void {
  const { mirror, url, base, branch } = spec;
  run("git", ["clone", "--quiet", "--no-checkout", mirror, dir]);
  let start = `origin/${base}`;
  if (hasRef(mirror, `refs/heads/${branch}`)) {
    start = `origin/${branch}`;
  }
  gitIn(dir, ["checkout", "--quiet", "-B", branch, start]);
  gitIn(dir, ["remote", "set-url", "origin", url]);
  configureClone(cfg, dir);
  guardCommits(dir);
}

// Makes stage job `stage`'s folder for issue `issue`, refusing to overwrite
// any earlier recovery checkout: code from the freshly fetched mirror, on
// `job.branch` (branch.ts).
function openJobCheckout(
  cfg: Config,
  issue: number,
  job: { stage: string; branch: string },
): JobDirs {
  const { stage } = job;
  const mirror = paths.mirror(cfg);
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  withCloneLock(cfg, (): void => syncMirror(cfg, mirror, url));
  const root = paths.jobCheckout(cfg, issue, stage);
  if (fs.existsSync(root)) {
    throw new Error(
      `job checkout ${root} already exists; preserve it for operator recovery before restarting`,
    );
  }
  fs.mkdirSync(root, { recursive: true });
  const repo = paths.jobRepo(cfg, issue, stage);
  const checkout = { issue, dir: repo, branch: job.branch };
  const scoped = withCheckout(cfg, checkout);
  const branch = paths.branch(scoped, issue);
  cloneInto(cfg, { mirror, url, base: cfg.baseBranch, branch }, repo);
  try {
    updateSubmodules(cfg, repo);
    return { root, repo, branch };
  } catch (error: unknown) {
    throw new CheckoutSetupError(
      `cannot prepare configured submodules: ${String(error)}. Restore access and the configured submodule/base, reconcile retained work, then explicitly restart. Checkout retained at ${root}; do not overwrite it or replay recovery patches automatically`,
      { cause: error },
    );
  }
}

// Makes a detached checkout of the base branch's head at `dir`, from the
// freshly fetched mirror, for a model session that only reads, and returns
// its commit.
function openBaseCheckout(cfg: Config, dir: string): string {
  const mirror = paths.mirror(cfg);
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  withCloneLock(cfg, (): void => syncMirror(cfg, mirror, url));
  run("git", ["clone", "--quiet", "--no-checkout", mirror, dir]);
  gitIn(dir, ["checkout", "--quiet", "--detach", `origin/${cfg.baseBranch}`]);
  gitIn(dir, ["remote", "set-url", "origin", url]);
  updateSubmodules(cfg, dir);
  return gitIn(dir, ["rev-parse", "HEAD"]).trim();
}

export type { JobDirs };
export { openBaseCheckout, openJobCheckout };
