// Closing a job preserves uncommitted patches and local code commits before
// removing its disposable checkout. A recovery failure retains the checkout.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { git } from "../github.ts";
import {
  assertCheckoutReadyForRemoval,
  releaseCheckoutSlot,
} from "../lane-slots.ts";
import { withCloneLock } from "../locks.ts";
import { run } from "../process.ts";
import type { JobDirs } from "./checkout.ts";
import { saveCodeRecovery } from "./code-recovery.ts";
import type { RecoveryOrigin, RecoverySnapshot } from "./dropped-patch.ts";
import { saveDroppedPatch, saveRecovery } from "./dropped-patch.ts";

interface DroppedChanges {
  lost: readonly string[];
  patches: readonly string[];
}
function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}
function hasGit(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}
// How many commits the checkout has that no branch on the remote has, so
// that commits another branch on the remote already holds count as pushed.
function unpushed(cfg: Config, dir: string): number {
  git(cfg, "dev", ["-C", dir, "fetch", "--quiet", "--prune", "origin"]);
  const range = ["rev-list", "--count", "HEAD", "--not", "--remotes=origin"];
  return Number(gitIn(dir, range).trim());
}

// True when `repo` is a clone with commits its remote lacks; a git step that
// fails is reported and counts as none.
function holdsUnpushed(cfg: Config, repo: string): boolean {
  return reported(
    (): boolean => hasGit(repo) && unpushed(cfg, repo) > 0,
    false,
  );
}

// Runs one exit step; when it fails, reports why on stderr and gives
// `fallback`, so that the steps after it still run.
function reported<T>(step: () => T, fallback: T): T {
  try {
    return step();
  } catch (error: unknown) {
    let message = String(error);
    if (error instanceof Error) {
      ({ message } = error);
    }
    process.stderr.write(`job: exit: ${message}\n`);
    return fallback;
  }
}

function snapshotKind(file: string): RecoverySnapshot["kind"] {
  if (file.endsWith(".index.patch")) {
    return "index";
  }
  return "working-tree";
}

type ClosingJob = JobDirs & {
  key: string;
  recovery?: RecoveryOrigin;
};

function preparePatches(
  cfg: Config,
  issue: number,
  job: ClosingJob,
): DroppedChanges {
  const { root, repo } = job;
  if (!hasGit(repo)) {
    return { lost: [], patches: [] };
  }
  const file = paths.droppedPatch(cfg, issue, job.key, "repo");
  const title = `Dropped changes of issue #${issue}, job ${job.key}, checkout repo/`;
  const prefix = `${path.relative(root, repo)}/`;
  const one = saveDroppedPatch(repo, { file, title });
  const snapshots = one.files.map(
    (saved: string): RecoverySnapshot => ({
      file: path.basename(saved),
      checkout: "repo",
      source: repo,
      kind: snapshotKind(saved),
      base: gitIn(repo, ["rev-parse", "HEAD"]).trim(),
    }),
  );
  if (snapshots.length > 0 && job.recovery !== undefined) {
    saveRecovery(cfg, {
      version: 1,
      repo: cfg.repo,
      issue,
      branch: job.branch,
      job: job.key,
      origin: job.recovery,
      snapshots,
    });
  }
  return {
    lost: one.lost.map((fileName: string): string => `${prefix}${fileName}`),
    patches: one.files.map((saved: string): string =>
      path.relative(paths.runDir(cfg, issue), saved),
    ),
  };
}

// Closes job folder `job.root` of issue `issue`: saves its code checkout's
// uncommitted changes as patches named by job key `job.key` and drops them,
// bundles local code before changing the checkout, then calls `push` when
// its code checkout holds commits the remote lacks, then removes the folder.
// A clean checkout gets no patch. Failed preparation retains the exact
// checkout and index; a restart must not overwrite that recovery work.
// A later push failure retains the checkout and the
// prepared artifacts, but cleanup may already have reset its dirty changes.
async function closeJobCheckout(
  cfg: Config,
  issue: number,
  job: ClosingJob,
  push: (() => Promise<void>) | null,
): Promise<DroppedChanges> {
  const { root, repo } = job;
  let removable = false;
  try {
    assertCheckoutReadyForRemoval(cfg, issue, repo);
    const dropped = preparePatches(cfg, issue, job);
    // Prepare every recovery artifact before changing the checkout.
    saveCodeRecovery(cfg, issue, repo, job.key);
    if (hasGit(repo)) {
      gitIn(repo, ["reset", "--quiet", "--hard"]);
      gitIn(repo, ["clean", "--quiet", "-fd"]);
    }
    if (push && holdsUnpushed(cfg, repo)) {
      await push();
    }
    removable = true;
    return dropped;
  } finally {
    if (removable) {
      withCloneLock(cfg, () => {
        assertCheckoutReadyForRemoval(cfg, issue, repo);
        fs.rmSync(root, { recursive: true, force: true });
        releaseCheckoutSlot(cfg);
      });
    } else {
      process.stderr.write(
        `job: recovery incomplete; checkout retained at ${root} for operator recovery\n`,
      );
    }
  }
}

export type { DroppedChanges };
export { closeJobCheckout };
