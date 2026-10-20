// A stage job's own checkouts of its issue (#250), in a folder no other job
// shares: `repo/`, a full clone with initialized submodules, and `docs/`,
// an alias of its wiki submodule that keeps the stage's docs pathspecs. Their
// origins are the real remotes, and they are set up as the ops CLI
// sets up its clone. Closing them saves what they left uncommitted as
// patches in the issue's run folder, lets a writer push authorized commits,
// keeps unpublished wiki work in its mirror, and bundles remaining local
// code for operator recovery before removal. Recovery failures retain the
// checkout; a later job never overwrites it.

import fs from "node:fs";
import path from "node:path";
import {
  configureClone,
  guardCommits,
  updateSubmodules,
} from "../clone-setup.ts";
import type { Config, JobCheckout } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withCloneLock, withWikiLock } from "../locks.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";
import { ensureWiki } from "../wiki.ts";

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

// A stage job's folder, its code checkout and its wiki checkout (null when
// the repo has no wiki, or its wiki can't be cloned).
interface JobDirs {
  root: string;
  repo: string;
  docs: string | null;
  // The issue branch the job's caller assigned, which both checkouts are on.
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
function syncMirror(
  cfg: Config,
  spec: { mirror: string; url: string; prune: boolean },
): void {
  const { mirror, url, prune } = spec;
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const clone = ["clone", "--mirror", url, mirror];
    git(cfg, "dev", clone);
  }
  const fetch = ["-C", mirror, "fetch", "origin"];
  fetch.push("--prune");
  if (!prune) {
    // Private wiki heads must never be destinations of remote refresh.
    fetch.push("--refmap=", "+refs/heads/*:refs/remotes/origin/*");
  }
  git(cfg, "dev", fetch);
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

// Chooses a descendant without losing either private or remote wiki work.
function wikiStart(mirror: string, branch: string): string | null {
  const saved = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  if (!hasRef(mirror, saved)) {
    if (hasRef(mirror, remote)) {
      return remote;
    }
    return null;
  }
  if (!hasRef(mirror, remote)) {
    return saved;
  }
  const privateHead = gitIn(mirror, ["rev-parse", saved]).trim();
  const remoteHead = gitIn(mirror, ["rev-parse", remote]).trim();
  const base = run(
    "git",
    ["-C", mirror, "merge-base", privateHead, remoteHead],
    { allowFail: true },
  );
  if (base.code === 0 && base.stdout.trim() === privateHead) {
    return remote;
  }
  if (base.code === 0 && base.stdout.trim() === remoteHead) {
    return saved;
  }
  throw new OpsError(
    "private wiki recovery and remote issue branch diverged or cannot be compared; both refs retained",
  );
}

// Exposes `checkout`'s wiki submodule as docs/ (`cfg` is scoped to it),
// restoring the previous job's unpublished work, for pipeline_commit's scope.
function openWiki(cfg: Config, checkout: JobCheckout): string | null {
  const { issue, dir: repo } = checkout;
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return null;
  }
  const into = paths.wiki(cfg, issue);
  const target = path.relative(path.dirname(into), path.join(repo, wiki.dir));
  fs.symlinkSync(target, into, "dir");
  // Availability comes from the configured submodule, not unpublished work.
  // Keep the alias in place while ensureWiki measures work at the pinned HEAD;
  // it can initialize a declared but not yet initialized submodule too.
  if (ensureWiki(cfg, issue) === null) {
    fs.unlinkSync(into);
    return null;
  }
  guardCommits(into);
  const mirror = paths.wikiMirror(cfg);
  const url = gitIn(into, ["remote", "get-url", "origin"]).trim();
  withWikiLock(cfg, (): void => {
    syncMirror(cfg, { mirror, url, prune: false });
    const branch = paths.branch(cfg, issue);
    const start = wikiStart(mirror, branch);
    if (start !== null) {
      gitIn(into, ["fetch", "--quiet", mirror, start]);
      gitIn(into, ["checkout", "--quiet", "-B", branch, "FETCH_HEAD"]);
    }
  });
  return into;
}

// Makes stage job `stage`'s folder for issue `issue`, refusing to overwrite
// any earlier recovery checkout: code from the freshly fetched mirror, and
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
    const docs = openWiki(scoped, checkout);
    return { root, repo, docs, branch };
  } catch (error: unknown) {
    const wiki = wikiCfg(cfg);
    let target = "configured submodules";
    if (wiki !== null) {
      target = `configured wiki submodule ${wiki.dir}, base ${wiki.branch}`;
    }
    throw new CheckoutSetupError(
      `cannot prepare ${target}: ${String(error)}. Restore access and the configured submodule/base, reconcile retained work, then explicitly restart. Checkout retained at ${root}; do not overwrite it or replay recovery patches automatically`,
      { cause: error },
    );
  }
}

export type { JobDirs };
export { CheckoutSetupError, openJobCheckout };
