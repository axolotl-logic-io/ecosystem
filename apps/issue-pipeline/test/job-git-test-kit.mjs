// @ts-check
// The stage job tests' git: a local bare origin seeded with one commit, its
// refs, and where a job's own checkout lives.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The base branch the job tests' config names.
const BASE = "integration";
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
 * Makes a bare repo at `bare` whose `branch` holds one commit of `files`.
 * @param {string} bare
 * @param {string} branch
 * @param {readonly string[]} files
 * @returns {void}
 */
function seedBare(bare, branch, files) {
  const seed = `${bare}-seed`;
  git(["init", "--quiet", "--bare", "-b", branch, bare]);
  git(["init", "--quiet", "-b", branch, seed]);
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), "base\n");
  }
  git(["-C", seed, "add", ...files]);
  git(["-C", seed, "commit", "--quiet", "-m", "base"]);
  git(["-C", seed, "push", "--quiet", bare, `HEAD:refs/heads/${branch}`]);
}

/**
 * Seeds the repo's origin in `tmp`, its base holding a README and the
 * repo's docs/Home.md. The config keys that point the job at it.
 * @param {string} tmp
 * @returns {{ origin: string, config: Record<string, unknown> }}
 */
function seedOrigin(tmp) {
  const origin = path.join(tmp, "origin.git");
  seedBare(origin, BASE, ["README.md", "docs/Home.md"]);
  return { origin, config: { cloneUrl: origin, baseBranch: BASE } };
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
 * Pushes a commit to issue `issue`'s branch on `origin` (#7's unless
 * given), as an earlier job's push would have; returns its sha.
 * @param {string} origin
 * @param {number} [issue]
 * @returns {string}
 */
function branchOnOrigin(origin, issue = 7) {
  const seed = `${origin}-seed`;
  const ref = `refs/heads/agent/issue-${issue}`;
  fs.writeFileSync(path.join(seed, `earlier-${issue}.txt`), "earlier\n");
  git(["-C", seed, "add", `earlier-${issue}.txt`]);
  git(["-C", seed, "commit", "--quiet", "-m", "earlier"]);
  git(["-C", seed, "push", "--quiet", origin, `HEAD:${ref}`]);
  git(["-C", seed, "reset", "--quiet", "--hard", "HEAD~1"]);
  return refOf(origin, ref);
}

/**
 * Where stage `stage`'s job for #7 keeps its folder, which holds its
 * checkouts, under the pipeline root `root`.
 * @param {string} root
 * @param {string} stage
 * @returns {string}
 */
function checkoutOf(root, stage) {
  return path.join(root, "work/o__r/jobs", `issue-7-${stage}`);
}

/**
 * Stage `stage`'s job's code checkout, repo/ in its folder.
 * @param {string} root
 * @param {string} stage
 * @returns {string}
 */
function repoOf(root, stage) {
  return path.join(checkoutOf(root, stage), "repo");
}

export { BASE, branchOnOrigin, checkoutOf, git, refOf, repoOf, seedOrigin };
