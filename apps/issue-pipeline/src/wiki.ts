// The wiki is a submodule of the code checkout. With wiki publishing enabled,
// each issue works on its own wiki branch; review includes its commits and
// wiki-publish.ts publishes them after the code merges.

import fs from "node:fs";
import path from "node:path";
import { configureClone, updateSubmodules, writeHook } from "./clone-setup.ts";
import type { Config, WikiSettings } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { uncommitted } from "./git-state.ts";
import { git } from "./github.ts";
import { withCloneLock, withWikiLock } from "./locks.ts";
import { run } from "./process.ts";

interface WikiDiff {
  diff: string;
  files: string[];
}

// `git ls-files --stage` of a merged gitlink: mode, commit, stage 0, path.
const MERGED_GITLINK = /^160000 [0-9a-f]+ 0\t/u;
// The hooks after which git itself holds the pin again: a rebase's picks
// and continues, a commit, a checkout and a rebase's or amend's rewrite.
const PIN_HOOKS: readonly string[] = [
  "post-commit",
  "post-checkout",
  "post-rewrite",
];

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// Keeps the wiki checkout's moving HEAD out of the pipeline's code checkout
// `parent`: its status and `git add -A` leave the wiki gitlink alone, while a
// staged pin still shows. It marks the gitlink assume-unchanged, a mark git
// drops whenever it writes the gitlink's index entry anew, as a rebase,
// reset or checkout that changes or replays the pin does (#458), so the sync,
// push and job exit paths call it again before they check or stage, and the
// checkout's hooks after git's own commits and rewrites. Does
// nothing without a wiki submodule, or while its gitlink is unmerged.
// Ordinary developer checkouts keep Git's default pin tracking.
function holdWikiPin(cfg: Config, parent: string): void {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return;
  }
  const entry = gitIn(parent, ["ls-files", "--stage", "--", wiki.dir]);
  if (MERGED_GITLINK.test(entry)) {
    gitIn(parent, ["update-index", "--assume-unchanged", "--", wiki.dir]);
  }
}

// holdWikiPin as a hook script for the gitlink at `dir`, which never fails
// the command it follows.
function pinHook(dir: string): string {
  const quoted = `'${dir.replaceAll("'", "'\\''")}'`;
  const merged = `git ls-files --stage -- ${quoted} | grep -q '^160000 [0-9a-f]* 0\t'`;
  const hold = `git update-index --assume-unchanged -- ${quoted}`;
  return `#!/bin/sh\n${merged} && ${hold}\nexit 0\n`;
}

// The wiki commit `rev` pins in `dir`, or "" when it pins none.
function pinAt(dir: string, wikiDir: string, rev: string): string {
  const args = [
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "--quiet",
    `${rev}:${wikiDir}`,
  ];
  return run("git", args, { allowFail: true }).stdout.trim();
}

// Why `dir`'s head, its branch rebased from `from` onto `onto`, pins another
// wiki commit than the branch's own commits give it, or undefined when it
// doesn't: `from`'s pin when the branch's commits since it forked from
// `onto` change the pin, else `onto`'s. A head that differs was given the
// wiki checkout's moved HEAD by a staging the held pin missed (#458).
function wikiPinProblem(
  cfg: Config,
  dir: string,
  { from, onto }: { from: string; onto: string },
): string | undefined {
  const wiki = wikiCfg(cfg);
  const forked = run("git", ["-C", dir, "merge-base", from, onto], {
    allowFail: true,
  });
  if (wiki === null || forked.code !== 0) {
    return undefined;
  }
  const own = pinAt(dir, wiki.dir, from);
  let expected = pinAt(dir, wiki.dir, onto);
  if (own !== pinAt(dir, wiki.dir, forked.stdout.trim())) {
    expected = own;
  }
  const pinned = pinAt(dir, wiki.dir, "HEAD");
  if (pinned === expected) {
    return undefined;
  }
  return `the head pins ${wiki.dir} commit ${pinned || "none"}, not ${expected || "none"}, the pin the branch's own commits give`;
}

// Has git itself hold the wiki pin of `parent` after each commit, checkout
// and rewrite, so a session's own rebase, continue and commits, which no op
// sees, never stage the wiki checkout's moved HEAD (#458).
function holdWikiPinInHooks(parent: string, dir: string): void {
  for (const name of PIN_HOOKS) {
    writeHook(parent, name, pinHook(dir));
  }
}

// The initialized wiki submodule, or null when this checkout declares none.
// Wiki commits are published separately, so its gitlink is held (holdWikiPin).
function wikiCheckout(cfg: Config, parent: string): string | null {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return null;
  }
  const dir = path.join(parent, wiki.dir);
  const entry = gitIn(parent, ["ls-files", "--stage", "--", wiki.dir]);
  if (!entry.startsWith("160000 ")) {
    return null;
  }
  if (!fs.existsSync(path.join(dir, ".git"))) {
    updateSubmodules(cfg, parent);
  }
  holdWikiPin(cfg, parent);
  holdWikiPinInHooks(parent, wiki.dir);
  configureClone(cfg, dir);
  git(cfg, ["-C", dir, "fetch", "--prune", "origin"]);
  return dir;
}

// True when the wiki remote's issue branch has unpublished commits.
function wikiBranchWork(wiki: WikiSettings, dir: string, n: number): boolean {
  const ref = `refs/remotes/origin/${paths.branch(n)}`;
  const verify = ["-C", dir, "rev-parse", "--verify", "--quiet", ref];
  if (run("git", verify, { allowFail: true }).code !== 0) {
    return false;
  }
  const range = `origin/${wiki.branch}..${ref}`;
  return Number(gitIn(dir, ["rev-list", "--count", range]).trim()) > 0;
}

// False with no configured wiki submodule or no unpublished issue branch.
function wikiBranchHasWork(cfg: Config, n: number): boolean {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return false;
  }
  return withWikiLock(cfg, () => {
    const dir = withCloneLock(cfg, () => wikiCheckout(cfg, paths.clone(cfg)));
    return dir !== null && wikiBranchWork(wiki, dir, n);
  });
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

// Readies the existing wiki submodule for this issue, preserving local work.
// A clean checkout with no commits of its own resumes the remote issue branch
// when that has work, or starts at the wiki's latest published version.
function ensureWiki(cfg: Config, n: number): string | null {
  const wiki = wikiCfg(cfg);
  if (wiki === null) {
    return null;
  }
  return withWikiLock(cfg, () => {
    const dir = withCloneLock(cfg, () =>
      wikiCheckout(cfg, paths.worktree(cfg, n)),
    );
    if (dir === null) {
      return null;
    }
    let base = `origin/${wiki.branch}`;
    if (wikiBranchWork(wiki, dir, n)) {
      base = `origin/${paths.branch(n)}`;
    }
    if (
      wikiAhead(cfg, n) === 0 &&
      gitIn(dir, ["status", "--porcelain"]).trim() === ""
    ) {
      gitIn(dir, ["checkout", "-B", paths.branch(n), base]);
    }
    return paths.wiki(cfg, n);
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

// Why the wiki checkout holds unpublished work, or null when it holds none.
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
  holdWikiPin,
  pushWikiBranch,
  unsavedWiki,
  wikiAhead,
  wikiBranchHasWork,
  wikiDiff,
  wikiPinProblem,
};
