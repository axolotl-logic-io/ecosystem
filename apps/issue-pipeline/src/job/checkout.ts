// A stage job's own checkout of its issue (#250): a full clone, made from a
// bare mirror of the repo, that no other job shares. Its origin is the real
// remote, so ops fetch and push there, and it is set up as the ops CLI sets
// up its clone. When the repo has a wiki, the checkout holds a clone of it
// too, made from a bare mirror of the wiki. Closing the checkout drops what
// it left uncommitted, lets a writer push its commits, keeps unpushed wiki
// commits in the wiki mirror for the issue's next job, and removes it.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { configureClone, GH_HELPER, guardCommits } from "../clone-setup.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { withCloneLock, withWikiLock } from "../locks.ts";
import { run } from "../process.ts";
import type { WikiAccess } from "./pipeline-commit.ts";

// A clone to make: the mirror it comes from, the remote its origin names, the
// base branch, the branch the issue's work is on, and the issue whose branch
// it is stacked on (#268), or null.
interface CloneSpec {
  mirror: string;
  url: string;
  base: string;
  branch: string;
  stackOn: number | null;
}

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

// Makes the bare mirror of `url` at `mirror` if it is missing, and fetches
// it. False when the remote can't be cloned and `optional` says that is no
// error.
function syncMirror(
  cfg: Config,
  spec: { mirror: string; url: string; prune: boolean; optional: boolean },
): boolean {
  const { mirror, url, prune, optional } = spec;
  if (!fs.existsSync(path.join(mirror, "HEAD"))) {
    fs.rmSync(mirror, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    const clone = [...GH_HELPER, "clone", "--mirror", url, mirror];
    const cloned = git(cfg, clone, { allowFail: optional });
    if (cloned.code !== 0) {
      fs.rmSync(mirror, { recursive: true, force: true });
      return false;
    }
  }
  const fetch = [...GH_HELPER, "-C", mirror, "fetch", "origin"];
  if (prune) {
    fetch.push("--prune");
  }
  git(cfg, fetch);
  return true;
}

// Clones `spec.mirror` into `dir` on the issue's branch: at the mirror's
// branch head when it has one, otherwise at the head of the branch it is
// stacked on when the mirror has that, and at the base otherwise. Only
// pipeline_commit and the ops commit there.
function cloneInto(cfg: Config, spec: CloneSpec, dir: string): void {
  const { mirror, url, base, branch, stackOn } = spec;
  run("git", ["clone", "--quiet", "--no-checkout", mirror, dir]);
  let start = `origin/${base}`;
  if (hasRef(mirror, `refs/heads/${branch}`)) {
    start = `origin/${branch}`;
  } else if (
    stackOn !== null &&
    hasRef(mirror, `refs/heads/${paths.branch(stackOn)}`)
  ) {
    start = `origin/${paths.branch(stackOn)}`;
  }
  gitIn(dir, ["checkout", "--quiet", "-B", branch, start]);
  gitIn(dir, ["remote", "set-url", "origin", url]);
  configureClone(cfg, dir);
  guardCommits(dir);
}

function excludeWiki(dir: string, wikiDir: string): void {
  const exclude = path.join(dir, ".git", "info", "exclude");
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, `\n/${wikiDir}/\n`);
}

// Clones the wiki into the checkout `dir`, unless the repo has no wiki yet.
function openWiki(cfg: Config, issue: number, dir: string): void {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return;
  }
  const mirror = paths.wikiMirror(cfg);
  const url = wiki.url ?? `https://github.com/${cfg.repo}.wiki.git`;
  const synced = withWikiLock(cfg, (): boolean =>
    syncMirror(cfg, { mirror, url, prune: false, optional: true }),
  );
  if (!synced) {
    return;
  }
  const into = paths.wiki(withCheckout(cfg, { issue, dir }), issue);
  const branch = paths.branch(issue);
  const spec = { mirror, url, base: wiki.branch, branch, stackOn: null };
  cloneInto(cfg, spec, into);
}

// Makes stage job `stage`'s checkout of issue `issue` from the freshly
// fetched mirror, replacing one an earlier job left, and returns its path.
// With `stackOn`, an issue with no branch yet starts on that issue's branch.
// It holds the wiki's checkout unless the stage's `wiki` access is none.
function openJobCheckout(
  cfg: Config,
  issue: number,
  job: { stage: string; stackOn: number | null; wiki: WikiAccess },
): string {
  const { stage, stackOn, wiki } = job;
  const mirror = paths.mirror(cfg);
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  withCloneLock(cfg, (): boolean =>
    syncMirror(cfg, { mirror, url, prune: true, optional: false }),
  );
  const dir = paths.jobCheckout(cfg, issue, stage);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const branch = paths.branch(issue);
  cloneInto(cfg, { mirror, url, base: cfg.baseBranch, branch, stackOn }, dir);
  excludeWiki(dir, wikiCfg(cfg)?.dir ?? "wiki");
  if (wiki !== "none") {
    openWiki(cfg, issue, dir);
  }
  return dir;
}

// The paths `dir` holds uncommitted, each after `prefix`, which it then
// drops.
function dropChanges(dir: string, prefix: string): string[] {
  if (!hasGit(dir)) {
    return [];
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
  gitIn(dir, ["reset", "--quiet", "--hard"]);
  gitIn(dir, ["clean", "--quiet", "-fd"]);
  return lost;
}

// How many commits the checkout has that no branch on the remote has, so
// that a branch stacked on another issue's (#268) holds none of that issue's.
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
  const ref = `refs/heads/${paths.branch(issue)}`;
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

// Closes the job checkout `dir` of issue `issue`: drops its uncommitted
// changes, calls `push` when it, or its wiki checkout under `wiki` write
// access, holds commits the remote lacks, saves its wiki commits and removes
// it. Resolves to the dropped paths, wiki paths
// under the wiki's folder. A git step that fails, such as a fetch from an
// unreachable remote, is reported on stderr and skipped, and the checkout is
// removed whatever fails.
async function closeJobCheckout(
  cfg: Config,
  issue: number,
  job: { dir: string; wiki: WikiAccess },
  push: (() => Promise<void>) | null,
): Promise<readonly string[]> {
  const { dir, wiki } = job;
  try {
    const wikiDir = paths.wiki(withCheckout(cfg, { issue, dir }), issue);
    const wikiPrefix = `${path.relative(dir, wikiDir)}/`;
    const lost = reported(
      (): string[] => [
        ...dropChanges(dir, ""),
        ...dropChanges(wikiDir, wikiPrefix),
      ],
      [],
    );
    if (
      push !== null &&
      (holdsUnpushed(cfg, dir) ||
        (wiki === "write" && holdsUnpushed(cfg, wikiDir)))
    ) {
      await push();
    }
    reported((): void => saveWiki(cfg, issue, wikiDir), undefined);
    return lost;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export { closeJobCheckout, openJobCheckout };
