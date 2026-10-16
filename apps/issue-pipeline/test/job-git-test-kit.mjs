// @ts-check
// The stage job tests' git: a local bare origin (and wiki origin) seeded with
// one commit, its refs, and where a job's own checkout lives.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The base branch the job tests' config names.
const BASE = "integration";
const WIKI_BRANCH = "master";
// Commits made outside a job need a name and no signing.
const IDENTITY = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
  "-c",
  "commit.gpgsign=false",
];

/** @param {readonly string[]} args @returns {string} git's trimmed stdout */
function git(args) {
  return execFileSync("git", [...IDENTITY, ...args], {
    encoding: "utf8",
  }).trim();
}

/**
 * Makes a bare repo at `bare` whose `branch` holds one commit of `file`.
 * @param {string} bare
 * @param {string} branch
 * @param {string} file
 * @returns {void}
 */
function seedBare(bare, branch, file) {
  const seed = `${bare}-seed`;
  git(["init", "--quiet", "--bare", "-b", branch, bare]);
  git(["init", "--quiet", "-b", branch, seed]);
  fs.writeFileSync(path.join(seed, file), "base\n");
  git(["-C", seed, "add", file]);
  git(["-C", seed, "commit", "--quiet", "-m", "base"]);
  git(["-C", seed, "push", "--quiet", bare, `HEAD:refs/heads/${branch}`]);
}

/**
 * Seeds the repo's origin, and its wiki's when `wiki` is set, in `tmp`. The
 * config keys that point the job at them.
 * @param {string} tmp
 * @param {boolean} wiki
 * @returns {{ origin: string, wikiOrigin: string | null, config: Record<string, unknown> }}
 */
function seedOrigins(tmp, wiki) {
  const origin = path.join(tmp, "origin.git");
  seedBare(origin, BASE, "README.md");
  const config = { cloneUrl: origin, baseBranch: BASE };
  if (!wiki) {
    return { origin, wikiOrigin: null, config };
  }
  const wikiOrigin = path.join(tmp, "wiki-origin.git");
  seedBare(wikiOrigin, WIKI_BRANCH, "Home.md");
  const wikiConfig = { url: wikiOrigin, branch: WIKI_BRANCH };
  return { origin, wikiOrigin, config: { ...config, wiki: wikiConfig } };
}

/**
 * The sha of `ref` in the bare repo `bare`, or "" when it has none.
 * @param {string} bare
 * @param {string} ref
 * @returns {string}
 */
function refOf(bare, ref) {
  try {
    return git(["--git-dir", bare, "rev-parse", "--quiet", "--verify", ref]);
  } catch {
    return "";
  }
}

/**
 * Pushes a commit to the issue's branch on `origin`, as an earlier job's
 * push would have; returns its sha.
 * @param {string} origin
 * @returns {string}
 */
function branchOnOrigin(origin) {
  const seed = `${origin}-seed`;
  fs.writeFileSync(path.join(seed, "earlier.txt"), "earlier\n");
  git(["-C", seed, "add", "earlier.txt"]);
  git(["-C", seed, "commit", "--quiet", "-m", "earlier"]);
  git(["-C", seed, "push", "--quiet", origin, "HEAD:refs/heads/agent/issue-7"]);
  git(["-C", seed, "reset", "--quiet", "--hard", "HEAD~1"]);
  return refOf(origin, "refs/heads/agent/issue-7");
}

/**
 * Where stage `stage`'s job for #7 keeps its checkout under the pipeline
 * root `root`.
 * @param {string} root
 * @param {string} stage
 * @returns {string}
 */
function checkoutOf(root, stage) {
  return path.join(root, "work/o__r/jobs", `issue-7-${stage}`);
}

export { BASE, branchOnOrigin, checkoutOf, refOf, seedOrigins };
