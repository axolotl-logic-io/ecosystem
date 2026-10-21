// Closing a job preserves uncommitted patches and local code commits before
// removing its disposable checkout. A recovery failure retains the checkout.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { git } from "../github.ts";
import { run } from "../process.ts";
import type { JobDirs } from "./checkout.ts";
import { saveCodeRecovery } from "./code-recovery.ts";
import type { RecoveryOrigin, RecoverySnapshot } from "./dropped-patch.ts";
import { saveDroppedPatch, saveRecovery } from "./dropped-patch.ts";
import type { Access } from "./pipeline-commit.ts";

interface DroppedChanges {
  lost: readonly string[];
  patches: readonly string[];
}
const CHECKOUTS: readonly ("repo" | "docs")[] = ["repo", "docs"];
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
  wiki: Access;
  key: string;
  recovery?: RecoveryOrigin;
};

function preparePatches(
  cfg: Config,
  issue: number,
  job: ClosingJob,
): DroppedChanges {
  const { root, wiki } = job;
  const lost: string[] = [];
  const patches: string[] = [];
  const snapshots: RecoverySnapshot[] = [];
  for (const name of CHECKOUTS) {
    const dir = job[name];
    if (dir !== null && hasGit(dir)) {
      const file = paths.droppedPatch(cfg, issue, job.key, name);
      const title = `Dropped changes of issue #${issue}, job ${job.key}, checkout ${name}/`;
      const prefix = `${path.relative(root, dir)}/`;
      const one = saveDroppedPatch(dir, { file, title });
      snapshots.push(
        ...one.files.map(
          (saved: string): RecoverySnapshot => ({
            file: path.basename(saved),
            checkout: name,
            source: dir,
            kind: snapshotKind(saved),
            base: gitIn(dir, ["rev-parse", "HEAD"]).trim(),
          }),
        ),
      );
      lost.push(
        ...one.lost.map((fileName: string): string => `${prefix}${fileName}`),
      );
      patches.push(
        ...one.files.map((saved: string): string =>
          path.relative(paths.runDir(cfg, issue), saved),
        ),
      );
    }
  }
  if (snapshots.length > 0 && job.recovery !== undefined) {
    saveRecovery(cfg, {
      version: 1,
      repo: cfg.repo,
      issue,
      branch: job.branch,
      job: job.key,
      wikiAccess: wiki,
      origin: job.recovery,
      snapshots,
    });
  }
  return { lost, patches };
}

// Closes job folder `job.root` of issue `issue`: saves its checkouts'
// uncommitted changes as patches named by job key `job.key` and drops them,
// bundles local code before changing either checkout, then calls `push` when
// its code checkout holds commits the remote lacks, then removes the folder.
// A clean checkout gets no patch. Failed preparation retains the exact
// checkouts and indexes; a restart must not overwrite that recovery work.
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
    const dropped = preparePatches(cfg, issue, job);
    // Prepare every recovery artifact before changing either checkout.
    saveCodeRecovery(cfg, issue, repo, job.key);
    for (const name of CHECKOUTS) {
      const dir = job[name];
      if (dir !== null && hasGit(dir)) {
        gitIn(dir, ["reset", "--quiet", "--hard"]);
        gitIn(dir, ["clean", "--quiet", "-fd"]);
      }
    }
    if (push && holdsUnpushed(cfg, repo)) {
      await push();
    }
    removable = true;
    return dropped;
  } finally {
    if (removable) {
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      process.stderr.write(
        `job: recovery incomplete; checkout retained at ${root} for operator recovery\n`,
      );
    }
  }
}

export type { DroppedChanges };
export { closeJobCheckout };
