// Wiki checkouts. Each issue's worktree gets the wiki at <worktree>/wiki, a
// worktree of a shared wiki clone on branch agent/issue-<n>. The code clone's
// info/exclude hides it from the code repo. Agents read it and may commit to
// it; prepare-review adds those commits to the review diff, and pushWiki pushes
// them to the wiki after the PR merges. A wiki that doesn't exist yet (GitHub
// creates it with the first page) is skipped.

import fs from "node:fs";
import path from "node:path";
import { configureClone, GH_HELPER } from "./checkouts.ts";
import { comment } from "./comments.ts";
import type { Config, WikiSettings } from "./config.ts";
import { paths, wikiCfg } from "./config.ts";
import { head, uncommitted } from "./git-state.ts";
import { git } from "./github.ts";
import { withWikiLock } from "./locks.ts";
import { OpsError, run } from "./process.ts";

const PUSH_ATTEMPTS = 3;

interface WikiDiff {
  diff: string;
  files: string[];
}

type WikiPush =
  | { pushed: true; sha: string }
  | { pushed: false; patch: string };

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
// checkout with no commits of its own is moved to the wiki's latest version.
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
    const base = `origin/${wiki.branch}`;
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

// Saves the issue's wiki commits as a patch in its run dir and says so on the
// issue, since the code has already merged.
function savePatch(cfg: Config, n: number, wiki: WikiSettings): WikiPush {
  const dir = paths.wiki(cfg, n);
  run("git", ["-C", dir, "rebase", "--abort"], { allowFail: true });
  const patch = path.join(paths.runDir(cfg, n), "wiki-unpushed.patch");
  const range = `origin/${wiki.branch}..HEAD`;
  fs.writeFileSync(patch, gitIn(dir, ["format-patch", "--stdout", range]));
  comment(
    cfg,
    n,
    { role: "merger" },
    `The wiki changes from this issue conflict with newer wiki edits, so they were not pushed. They are saved as a patch at \`${patch}\` on the pipeline's machine.`,
  );
  return { pushed: false, patch };
}

// After the PR merges: replay the issue's wiki commits on the wiki's latest
// version and push them. On a conflict the commits are saved as a patch.
function pushWiki(cfg: Config, n: number): WikiPush | null {
  const wiki = wikiCfg(cfg);
  if (wiki === null || wikiAhead(cfg, n) === 0) {
    return null;
  }
  const dir = paths.wiki(cfg, n);
  const target = `HEAD:refs/heads/${wiki.branch}`;
  return withWikiLock(cfg, () => {
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
      git(cfg, ["-C", dir, "fetch", "origin", wiki.branch]);
      const rebase = ["-C", dir, "rebase", `origin/${wiki.branch}`];
      if (run("git", rebase, { allowFail: true }).code !== 0) {
        return savePatch(cfg, n, wiki);
      }
      const pushed = git(cfg, ["-C", dir, "push", "origin", target], {
        allowFail: true,
      });
      if (pushed.code === 0) {
        return { pushed: true, sha: head(dir) };
      }
    }
    throw new OpsError("could not push the wiki changes after 3 attempts");
  });
}

// Why the issue's wiki checkout holds work the wiki lacks (uncommitted changes,
// or commits not on the wiki's branch, such as a saved unpushed patch's), or
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

export type { WikiDiff, WikiPush };
export { ensureWiki, pushWiki, unsavedWiki, wikiAhead, wikiDiff };
