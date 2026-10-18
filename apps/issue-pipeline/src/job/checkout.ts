// A stage job's own checkouts of its issue (#250), in a folder no other job
// shares: `repo/`, a full clone with initialized submodules, and `docs/`,
// an alias of its wiki submodule that keeps the stage's docs pathspecs. Their
// origins are the real remotes, and they are set up as the ops CLI
// sets up its clone. Closing them saves what they left uncommitted as
// patches in the issue's run folder and drops it (dropped-changes-saved,
// #369), lets a writer push its commits, keeps unpushed wiki commits in the
// wiki mirror for the issue's next job, and removes the folder.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  configureClone,
  GH_HELPER,
  guardCommits,
  updateSubmodules,
} from "../clone-setup.ts";
import type { Config, JobCheckout } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withCloneLock, withWikiLock } from "../locks.ts";
import { run } from "../process.ts";
import { ensureWiki, holdWikiPin } from "../wiki.ts";
import { saveDroppedPatch } from "./dropped-patch.ts";
import type { Access } from "./pipeline-commit.ts";

// A clone to make: the mirror it comes from, the remote its origin names, the
// base branch and the branch the issue's work is on.
interface CloneSpec {
  mirror: string;
  url: string;
  base: string;
  branch: string;
}

// A stage job's folder, its code checkout and its wiki checkout (null when
// the repo has no wiki, or its wiki can't be cloned).
interface JobDirs {
  root: string;
  repo: string;
  docs: string | null;
  // The issue branch the job's caller assigned, which both checkouts are on.
  branch: string;
}

// What closing a job's checkouts dropped: the uncommitted paths, each under
// its checkout's folder (`repo/`, `docs/`), and the patches that saved them,
// relative to the issue's run folder.
interface DroppedChanges {
  lost: readonly string[];
  patches: readonly string[];
}

// A job's checkouts, by their folders' names in the job's folder.
const CHECKOUTS: readonly ("repo" | "docs")[] = ["repo", "docs"];
const NOTHING_DROPPED: DroppedChanges = { lost: [], patches: [] };
// A `git status --porcelain` entry is two status letters and a space, then
// the path.
const STATUS_PATH_AT = 3;

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

function hasRef(dir: string, ref: string): boolean {
  const args = ["-C", dir, "rev-parse", "--verify", "--quiet", ref];
  return run("git", args, { allowFail: true }).code === 0;
}

function hasGit(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

// Makes the bare mirror of `url` at `mirror` if missing, then fetches it.
function syncMirror(
  cfg: Config,
  spec: { mirror: string; url: string; prune: boolean },
): void {
  const { mirror, url, prune } = spec;
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const clone = [...GH_HELPER, "clone", "--mirror", url, mirror];
    git(cfg, clone);
  }
  const fetch = [...GH_HELPER, "-C", mirror, "fetch", "origin"];
  if (prune) {
    fetch.push("--prune");
  }
  git(cfg, fetch);
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

// Exposes `checkout`'s wiki submodule as docs/ (`cfg` is scoped to it),
// restoring the previous job's unpublished work, for pipeline_commit's scope.
function openWiki(cfg: Config, checkout: JobCheckout): string | null {
  const { issue, dir: repo } = checkout;
  const wiki = wikiCfg(cfg);
  if (wiki === null || !hasGit(path.join(repo, wiki.dir))) {
    return null;
  }
  const into = paths.wiki(cfg, issue);
  const target = path.relative(path.dirname(into), path.join(repo, wiki.dir));
  fs.symlinkSync(target, into, "dir");
  ensureWiki(cfg, issue);
  guardCommits(into);
  const mirror = paths.wikiMirror(cfg);
  const url = gitIn(into, ["remote", "get-url", "origin"]).trim();
  withWikiLock(cfg, (): void => {
    syncMirror(cfg, { mirror, url, prune: false });
    const branch = paths.branch(cfg, issue);
    if (hasRef(mirror, `refs/heads/${branch}`)) {
      gitIn(into, ["fetch", "--quiet", mirror, `refs/heads/${branch}`]);
      gitIn(into, ["checkout", "--quiet", "-B", branch, "FETCH_HEAD"]);
    }
  });
  return into;
}

// Makes stage job `stage`'s folder for issue `issue`, replacing one an
// earlier job left: its code checkout from the freshly fetched mirror, and
// its wiki checkout when the repo has a wiki, both on `job.branch` (branch.ts).
function openJobCheckout(
  cfg: Config,
  issue: number,
  job: { stage: string; branch: string },
): JobDirs {
  const { stage } = job;
  const mirror = paths.mirror(cfg);
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  withCloneLock(cfg, (): void => syncMirror(cfg, { mirror, url, prune: true }));
  const root = paths.jobCheckout(cfg, issue, stage);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const repo = paths.jobRepo(cfg, issue, stage);
  const checkout = { issue, dir: repo, branch: job.branch };
  const scoped = withCheckout(cfg, checkout);
  const branch = paths.branch(scoped, issue);
  cloneInto(cfg, { mirror, url, base: cfg.baseBranch, branch }, repo);
  updateSubmodules(cfg, repo);
  const docs = openWiki(scoped, checkout);
  return { root, repo, docs, branch };
}

// The paths `dir` holds uncommitted, each after `prefix`, which it then
// drops, once it has saved them as the patch `to`; `saved` says whether it
// wrote one. A failed save is reported, and they are dropped all the same.
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
  const saved = reported((): boolean => saveDroppedPatch(dir, to), false);
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
// removes the folder. A clean checkout gets no patch. A git or fs step that
// fails, such as a fetch from an unreachable remote, is reported on stderr
// and skipped, and the folder is removed whatever fails.
async function closeJobCheckout(
  cfg: Config,
  issue: number,
  job: JobDirs & { wiki: Access; key: string },
  push: (() => Promise<void>) | null,
): Promise<DroppedChanges> {
  const { root, repo, docs, wiki } = job;
  try {
    const dropped = reported((): DroppedChanges => {
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
    }, NOTHING_DROPPED);
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
    return dropped;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export type { DroppedChanges, JobDirs };
export { closeJobCheckout, openJobCheckout };
