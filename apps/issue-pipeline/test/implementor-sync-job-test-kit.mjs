// @ts-check
// The implementor's start sync in a stage job (#419), with local git: the
// fake ops replies that make sync-base and finish-sync do their work in the
// job's checkout (fake-rpc-pi.mjs), an issue branch on the origin that the
// base has moved past, cleanly or with a conflict in README.md, and whether
// one commit is in another's history on the origin, and the claim a later
// job gets.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { BASE, refOf } from "./job-git-test-kit.mjs";

// sync-base and finish-sync with local git in the job's checkout.
const SYNC_OPS = { "sync-base": { git: true }, "finish-sync": { git: true } };
const BRANCH = "refs/heads/agent/issue-7";
const BASE_REF = `refs/heads/${BASE}`;
// Commits made outside a job need a name and no signing.
const IDENTITY = [
  "-c",
  "user.name=Seed",
  "-c",
  "user.email=seed@example.com",
  "-c",
  "commit.gpgsign=false",
];

/** @param {string} dir @param {readonly string[]} args */
function git(dir, args) {
  execFileSync("git", [...IDENTITY, "-C", dir, ...args], { encoding: "utf8" });
}

/** @param {string} origin @param {string} file @param {string} text @param {string} ref commits `text` as `file` in the origin's seed and pushes it to `ref` */
function commitTo(origin, file, text, ref) {
  const seed = `${origin}-seed`;
  fs.writeFileSync(path.join(seed, file), text);
  git(seed, ["add", file]);
  git(seed, ["commit", "--quiet", "-m", `${file}: ${text.trim()}`]);
  git(seed, ["push", "--quiet", origin, `HEAD:${ref}`]);
}

/**
 * Pushes #7's branch to `origin` with one commit of its own on the base, then
 * moves the base on by a commit to README.md. The branch's commit edits
 * README.md too when `conflict`, so a rebase stops on it; otherwise it adds
 * own.txt and rebases cleanly. Returns both heads on the origin.
 * @param {string} origin
 * @param {boolean} conflict
 * @returns {{ branchSha: string, baseSha: string }}
 */
function behindBase(origin, conflict) {
  let file = "own.txt";
  if (conflict) {
    file = "README.md";
  }
  commitTo(origin, file, "branch\n", BRANCH);
  const branchSha = refOf(origin, BRANCH);
  git(`${origin}-seed`, ["reset", "--quiet", "--hard", "HEAD~1"]);
  commitTo(origin, "README.md", "moved\n", BASE_REF);
  return { branchSha, baseSha: refOf(origin, BASE_REF) };
}

/**
 * Makes the next job's claim give `state`, as an earlier job saved it, with
 * the branch's head on GitHub at `remoteHead`.
 * @param {{ root: string }} place
 * @param {unknown} state
 * @param {string} remoteHead
 */
function reclaim(place, state, remoteHead) {
  const file = path.join(place.root, "replies.json");
  const replies = JSON.parse(fs.readFileSync(file, "utf8"));
  const claim = { ...replies.claim, state, remoteHead };
  fs.writeFileSync(file, JSON.stringify({ ...replies, claim }));
}

/** @param {string} origin @returns {string} #7's branch's head on `origin` */
function branchHead(origin) {
  return refOf(origin, BRANCH);
}

/**
 * Whether `ancestor` is in the history of `commit` in the bare repo `origin`.
 * @param {string} origin
 * @param {string} ancestor
 * @param {string} commit
 * @returns {boolean}
 */
function contains(origin, ancestor, commit) {
  const args = ["--git-dir", origin, "merge-base", "--is-ancestor"];
  return spawnSync("git", [...args, ancestor, commit]).status === 0;
}

export { BASE_REF, behindBase, branchHead, contains, reclaim, SYNC_OPS };
