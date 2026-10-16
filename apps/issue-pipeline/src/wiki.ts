// Wiki checkouts. Each issue's worktree gets the wiki at <worktree>/wiki, a
// worktree of a shared wiki clone on branch agent/issue-<n>. The code clone's
// info/exclude hides it from the code repo. Agents read it and may commit to
// it; each code push also keeps them on the wiki remote's agent/issue-<n>, so a
// lane on a fresh machine rebuilds the checkout from there. prepare-review adds
// those commits to the review diff, and wiki-publish.ts rebases them onto the
// wiki's main branch and pushes them there after the PR merges. A wiki that
// doesn't exist yet (GitHub creates it with the first page) is skipped.

import fs from "node:fs";
import path from "node:path";
import { configureClone, GH_HELPER } from "./clone-setup.ts";
import type { Config, WikiSettings } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { uncommitted } from "./git-state.ts";
import { git } from "./github.ts";
import { withWikiLock } from "./locks.ts";
import { run } from "./process.ts";

interface WikiDiff {
  diff: string;
  files: string[];
}

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// The shared wiki clone, or null when the repo has no wiki yet.
function ensureWikiClone(cfg: Config, wiki: WikiSettings): string | null {
  const clone = paths.wikiClone(cfg);
  if (!fs.existsSync(path.join(clone, ".git"))) {
    const url = wiki.url ?? `https://github.com/${cfg.repo}.wiki.git`;
    const cloned = git(cfg, [...GH_HELPER, "clone", url, clone], {
      allowFail: true,
    });
    if (cloned.code !== 0) {
      return null;
    }
  }
  configureClone(cfg, clone);
  git(cfg, ["-C", clone, "fetch", "--prune", "origin"]);
  gitIn(clone, ["worktree", "prune"]);
  return clone;
}

// True when the wiki remote's agent/issue-<n>, as last fetched into the shared
// clone, has commits the wiki's main branch lacks.
function wikiBranchWork(wiki: WikiSettings, clone: string, n: number): boolean {
  const ref = `refs/remotes/origin/${paths.branch(n)}`;
  const verify = ["-C", clone, "rev-parse", "--verify", "--quiet", ref];
  if (run("git", verify, { allowFail: true }).code !== 0) {
    return false;
  }
  const range = `origin/${wiki.branch}..${ref}`;
  return Number(gitIn(clone, ["rev-list", "--count", range]).trim()) > 0;
}

// True when the wiki remote's agent/issue-<n> holds commits of the issue's that
// the wiki's main branch doesn't; false with no wiki or no such branch.
function wikiBranchHasWork(cfg: Config, n: number): boolean {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return false;
  }
  return withWikiLock(cfg, () => {
    const clone = ensureWikiClone(cfg, wiki);
    return clone !== null && wikiBranchWork(wiki, clone, n);
  });
}

function excludeFromCode(cfg: Config, wiki: WikiSettings): void {
  const exclude = path.join(paths.clone(cfg), ".git", "info", "exclude");
  const line = `/${wiki.dir}/`;
  let excluded = "";
  if (fs.existsSync(exclude)) {
    excluded = fs.readFileSync(exclude, "utf8");
  }
  if (!excluded.split("\n").includes(line)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `\n${line}\n`);
  }
}

// How many commits the issue's wiki checkout has that the wiki doesn't.
function wikiAhead(cfg: Config, n: number): number {
  const dir = paths.wiki(cfg, n);
  const wiki = wikiCfg(cfg);
  if (wiki === null || !fs.existsSync(path.join(dir, ".git"))) {
    return 0;
  }
  const range = `origin/${wiki.branch}..HEAD`;
  return Number(gitIn(dir, ["rev-list", "--count", range]).trim());
}

// Returns the issue's wiki checkout, or null when the repo has no wiki. A
// checkout with no commits of its own is moved to the wiki remote's
// agent/issue-<n> when that has commits of its own, else to the wiki's latest
// version.
function ensureWiki(cfg: Config, n: number): string | null {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return null;
  }
  excludeFromCode(cfg, wiki);
  return withWikiLock(cfg, () => {
    const clone = ensureWikiClone(cfg, wiki);
    if (clone === null) {
      return null;
    }
    const dir = paths.wiki(cfg, n);
    let base = `origin/${wiki.branch}`;
    if (wikiBranchWork(wiki, clone, n)) {
      base = `origin/${paths.branch(n)}`;
    }
    if (!fs.existsSync(path.join(dir, ".git"))) {
      gitIn(clone, ["worktree", "add", "-B", paths.branch(n), dir, base]);
    } else if (
      wikiAhead(cfg, n) === 0 &&
      gitIn(dir, ["status", "--porcelain"]).trim() === ""
    ) {
      gitIn(dir, ["reset", "--hard", base]);
    }
    return dir;
  });
}

// Keeps the issue's wiki commits on the wiki remote's agent/issue-<n>. Does
// nothing when the checkout has no commits of its own; a failed push throws.
function pushWikiBranch(cfg: Config, n: number): void {
  if (wikiAhead(cfg, n) === 0) {
    return;
  }
  const dir = paths.wiki(cfg, n);
  const target = `HEAD:refs/heads/${paths.branch(n)}`;
  withWikiLock(cfg, () =>
    git(cfg, ["-C", dir, "push", "--force-with-lease", "origin", target]),
  );
}

// The wiki's part of a review diff: every wiki commit the issue made so far.
function wikiDiff(cfg: Config, n: number): WikiDiff {
  const wiki = wikiCfg(cfg);
  if (wiki === null || wikiAhead(cfg, n) === 0) {
    return { diff: "", files: [] };
  }
  const dir = paths.wiki(cfg, n);
  const range = `origin/${wiki.branch}...HEAD`;
  const diff = gitIn(dir, ["diff", "--stat", "--patch", range]);
  const files = gitIn(dir, ["diff", "--name-only", range])
    .split("\n")
    .filter((file) => file !== "")
    .map((file) => `${wiki.dir}/${file}`);
  return { diff, files };
}

// Why the issue's wiki checkout holds work the wiki lacks (uncommitted changes,
// or commits not on the wiki's branch, such as an unpublished rebase's), or
// null when it holds none or there is no checkout.
function unsavedWiki(cfg: Config, n: number): string | null {
  const wiki = wikiCfg(cfg);
  const dir = paths.wiki(cfg, n);
  if (wiki === null || !fs.existsSync(path.join(dir, ".git"))) {
    return null;
  }
  return withWikiLock(cfg, () => {
    const refspec = `+refs/heads/${wiki.branch}:refs/remotes/origin/${wiki.branch}`;
    git(cfg, ["-C", dir, "fetch", "origin", refspec]);
    const dirty = uncommitted(dir, "the wiki checkout");
    if (dirty !== null) {
      return dirty;
    }
    const ahead = wikiAhead(cfg, n);
    if (ahead > 0) {
      return `the wiki checkout has ${ahead} commit(s) not on the wiki`;
    }
    return null;
  });
}

export type { WikiDiff };
export {
  ensureWiki,
  pushWikiBranch,
  unsavedWiki,
  wikiAhead,
  wikiBranchHasWork,
  wikiDiff,
};
