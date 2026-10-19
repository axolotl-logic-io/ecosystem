// Closing a job preserves uncommitted patches and local code commits before
// removing its disposable checkout. A recovery failure retains the checkout.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withWikiLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import type { JobDirs } from "./checkout.ts";
import { saveCodeRecovery } from "./code-recovery.ts";
import { saveDroppedPatch } from "./dropped-patch.ts";
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

// Keeps the wiki checkout's unpushed commits as the issue's branch in the
// wiki mirror, where its next job starts from; with none, drops that branch.
function saveWiki(cfg: Config, issue: number, wikiDir: string): void {
  const wiki = wikiCfg(cfg);
  const mirror = paths.wikiMirror(cfg);
  if (wiki === null || !hasGit(wikiDir)) {
    return;
  }
  if (
    !fs.existsSync(mirror) ||
    gitIn(mirror, ["rev-parse", "--is-bare-repository"]).trim() !== "true"
  ) {
    throw new OpsError(
      `wiki mirror ${mirror} is unavailable; checkout retained`,
    );
  }
  const ref = `refs/heads/${paths.branch(cfg, issue)}`;
  const range = `origin/${wiki.branch}..HEAD`;
  const ahead = Number(gitIn(wikiDir, ["rev-list", "--count", range]).trim());
  withWikiLock(cfg, (): void => {
    if (ahead > 0) {
      gitIn(mirror, ["fetch", "--quiet", wikiDir, `+HEAD:${ref}`]);
      return;
    }
    gitIn(mirror, ["update-ref", "-d", ref]);
  });
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

// Closes job folder `job.root` of issue `issue`: saves its checkouts'
// uncommitted changes as patches named by job key `job.key` and drops them,
// bundles local code before changing either checkout, then calls `push` when
// its code checkout, or its wiki checkout under `job.wiki` write access, holds
// commits the remote lacks. Saves its wiki commits, then removes the folder.
// A clean checkout gets no patch. Failed preparation retains the exact
// checkouts and indexes; a restart must not overwrite that recovery work.
// A later push or mirror-reconciliation failure retains the checkout and the
// prepared artifacts, but cleanup may already have reset its dirty changes.
async function closeJobCheckout(
  cfg: Config,
  issue: number,
  job: JobDirs & { wiki: Access; key: string },
  push: (() => Promise<void>) | null,
): Promise<DroppedChanges> {
  const { root, repo, docs, wiki } = job;
  const scoped = withCheckout(cfg, { issue, dir: repo, branch: job.branch });
  let removable = false;
  try {
    const dropped = ((): DroppedChanges => {
      const lost: string[] = [];
      const patches: string[] = [];
      for (const name of CHECKOUTS) {
        const dir = job[name];
        if (dir !== null && hasGit(dir)) {
          const file = paths.droppedPatch(cfg, issue, job.key, name);
          const title = `Dropped changes of issue #${issue}, job ${job.key}, checkout ${name}/`;
          const prefix = `${path.relative(root, dir)}/`;
          const one = saveDroppedPatch(cfg, dir, { file, title });
          lost.push(
            ...one.lost.map(
              (fileName: string): string => `${prefix}${fileName}`,
            ),
          );
          patches.push(
            ...one.files.map((saved: string): string =>
              path.relative(paths.runDir(cfg, issue), saved),
            ),
          );
        }
      }
      return { lost, patches };
    })();
    // Prepare every recovery artifact before changing either checkout.
    saveCodeRecovery(cfg, issue, repo, job.key);
    if (docs !== null) {
      saveWiki(scoped, issue, docs);
    }
    for (const name of CHECKOUTS) {
      const dir = job[name];
      if (dir !== null && hasGit(dir)) {
        gitIn(dir, ["reset", "--quiet", "--hard"]);
        gitIn(dir, ["clean", "--quiet", "-fd"]);
      }
    }
    if (
      push !== null &&
      (holdsUnpushed(cfg, repo) ||
        (wiki === "write" && docs !== null && holdsUnpushed(cfg, docs)))
    ) {
      await push();
    }
    if (docs !== null) {
      saveWiki(scoped, issue, docs);
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
