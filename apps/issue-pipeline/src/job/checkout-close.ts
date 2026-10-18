// Closing a job preserves uncommitted patches and local code commits before
// removing its disposable checkout. A recovery failure retains the checkout.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withWikiLock } from "../locks.ts";
import { run } from "../process.ts";
import { holdWikiPin } from "../wiki.ts";
import type { JobDirs } from "./checkout.ts";
import { saveCodeRecovery } from "./code-recovery.ts";
import { saveDroppedPatch } from "./dropped-patch.ts";
import type { Access } from "./pipeline-commit.ts";

interface DroppedChanges {
  lost: readonly string[];
  patches: readonly string[];
}
const CHECKOUTS: readonly ("repo" | "docs")[] = ["repo", "docs"];
const STATUS_PATH_AT = 3;
function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}
function hasGit(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}
// The paths `dir` holds uncommitted, each after `prefix`, which it then
// drops, once it has saved them as the patch `to`; `saved` says whether it
// wrote one. A failed save throws before any destructive operation.
function dropChanges(
  dir: string,
  prefix: string,
  to: { file: string; title: string },
): { lost: string[]; saved: boolean } {
  if (!hasGit(dir)) {
    return { lost: [], saved: false };
  }
  const status = ["status", "--porcelain", "-z", "--untracked-files=all"];
  const entries = gitIn(dir, status).split("\0");
  const lost: string[] = [];
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at] ?? "";
    if (entry !== "") {
      lost.push(`${prefix}${entry.slice(STATUS_PATH_AT)}`);
    }
    // A rename or copy is followed by the path it came from.
    if (entry.startsWith("R") || entry.startsWith("C")) {
      at += 1;
    }
  }
  const saved = saveDroppedPatch(dir, to);
  gitIn(dir, ["reset", "--quiet", "--hard"]);
  gitIn(dir, ["clean", "--quiet", "-fd"]);
  return { lost, saved };
}

// How many commits the checkout has that no branch on the remote has, so
// that commits another branch on the remote already holds count as pushed.
function unpushed(cfg: Config, dir: string): number {
  git(cfg, ["-C", dir, "fetch", "--quiet", "--prune", "origin"]);
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
  if (wiki === null || !hasGit(wikiDir) || !fs.existsSync(mirror)) {
    return;
  }
  const ref = `refs/heads/${paths.branch(cfg, issue)}`;
  const range = `origin/${wiki.branch}..HEAD`;
  const ahead = Number(gitIn(wikiDir, ["rev-list", "--count", range]).trim());
  withWikiLock(cfg, (): void => {
    if (ahead > 0) {
      gitIn(mirror, ["fetch", "--quiet", wikiDir, `+HEAD:${ref}`]);
      return;
    }
    run("git", ["-C", mirror, "update-ref", "-d", ref], { allowFail: true });
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
// calls `push` when its code checkout, or its wiki checkout under `job.wiki`
// write access, holds commits the remote lacks, saves its wiki commits and
// bundles code still absent from the remote, then removes the folder. A clean
// checkout gets no patch. Failed patch/bundle saves retain the checkout and
// throw; a restart must not overwrite that operator recovery work.
async function closeJobCheckout(
  cfg: Config,
  issue: number,
  job: JobDirs & { wiki: Access; key: string },
  push: (() => Promise<void>) | null,
): Promise<DroppedChanges> {
  const { root, repo, docs, wiki } = job;
  let removable = false;
  try {
    const dropped = ((): DroppedChanges => {
      // A moved wiki checkout is no change of the code checkout's.
      holdWikiPin(cfg, repo);
      const lost: string[] = [];
      const patches: string[] = [];
      for (const name of CHECKOUTS) {
        const dir = job[name];
        if (dir !== null) {
          const file = paths.droppedPatch(cfg, issue, job.key, name);
          const title = `Dropped changes of issue #${issue}, job ${job.key}, checkout ${name}/`;
          const prefix = `${path.relative(root, dir)}/`;
          const one = dropChanges(dir, prefix, { file, title });
          lost.push(...one.lost);
          if (one.saved) {
            patches.push(path.relative(paths.runDir(cfg, issue), file));
          }
        }
      }
      return { lost, patches };
    })();
    if (
      push !== null &&
      (holdsUnpushed(cfg, repo) ||
        (wiki === "write" && docs !== null && holdsUnpushed(cfg, docs)))
    ) {
      await push();
    }
    if (docs !== null) {
      const scoped = withCheckout(cfg, {
        issue,
        dir: repo,
        branch: job.branch,
      });
      reported((): void => saveWiki(scoped, issue, docs), undefined);
    }
    // Even a refused exit push cannot strand commits in the folder we delete.
    saveCodeRecovery(cfg, issue, repo, job.key);
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
