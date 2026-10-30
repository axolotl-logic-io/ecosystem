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
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { CommitIdentity } from "./clone-setup.ts";
import {
  configureClone,
  guardCommits,
  updateSubmodules,
} from "./clone-setup.ts";
import { type RunResult, run } from "./command.ts";

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
function syncMirror(access: GitAccess, mirror: string, url: string): void {
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const clone = ["clone", "--mirror", url, mirror];
    access.run(clone);
  }
  access.run(["-C", mirror, "fetch", "origin", "--prune"]);
}

// Clones `spec.mirror` into `dir` on the issue's branch: at the mirror's
// branch head when it has one, and at the base otherwise. Only
// pipeline_commit and the ops commit there.
function cloneInto(
  identity: CommitIdentity,
  spec: CloneSpec,
  dir: string,
): void {
  const { mirror, url, base, branch } = spec;
  run("git", ["clone", "--quiet", "--no-checkout", mirror, dir]);
  let start = `origin/${base}`;
  if (hasRef(mirror, `refs/heads/${branch}`)) {
    start = `origin/${branch}`;
  }
  gitIn(dir, ["checkout", "--quiet", "-B", branch, start]);
  gitIn(dir, ["remote", "set-url", "origin", url]);
  configureClone(identity, dir);
  guardCommits(dir);
}

// Makes stage job `stage`'s folder for issue `issue`, refusing to overwrite
// any earlier recovery checkout: code from the freshly fetched mirror, on
// `job.branch` (branch.ts).
interface GitAccess {
  run: (args: readonly string[]) => RunResult;
  withMirrorLock: <T>(operation: () => T) => T;
}
interface RepositorySource {
  mirror: string;
  url: string;
  base: string;
}
interface WritableCheckout extends RepositorySource, JobDirs {
  identity: CommitIdentity;
}

function openJobCheckout(spec: WritableCheckout, access: GitAccess): JobDirs {
  const { mirror, url, root, repo, branch, identity } = spec;
  access.withMirrorLock((): void => syncMirror(access, mirror, url));
  if (fs.existsSync(root)) {
    throw new Error(
      `job checkout ${root} already exists; preserve it for operator recovery before restarting`,
    );
  }
  fs.mkdirSync(root, { recursive: true });
  cloneInto(identity, { mirror, url, base: spec.base, branch }, repo);
  try {
    updateSubmodules(access, repo);
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
function openBaseCheckout(
  source: RepositorySource,
  dir: string,
  access: GitAccess,
): string {
  const { mirror, url, base } = source;
  access.withMirrorLock((): void => syncMirror(access, mirror, url));
  run("git", ["clone", "--quiet", "--no-checkout", mirror, dir]);
  gitIn(dir, ["checkout", "--quiet", "--detach", `origin/${base}`]);
  gitIn(dir, ["remote", "set-url", "origin", url]);
  updateSubmodules(access, dir);
  return gitIn(dir, ["rev-parse", "HEAD"]).trim();
}

export type { GitAccess, JobDirs, RepositorySource, WritableCheckout };
export { openBaseCheckout, openJobCheckout };
