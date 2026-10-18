// @ts-check
// Original local commits, index and dirty bytes for orchestrator refusal checks.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { cfg } from "./orchestrator-world-test-kit.mjs";

const { paths } = await import("../src/config.ts");

/** @param {readonly string[]} args @returns {string} */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** @param {number} number */
function heldCheckout(number) {
  const wt = paths.worktree(cfg, number);
  const origin = path.join(isolatedRoot, "origin.git");
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(["clone", "--quiet", origin, wt]);
  fs.writeFileSync(path.join(wt, "held.txt"), "local commit\n");
  git(["-C", wt, "add", "held.txt"]);
  git([
    "-C",
    wt,
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
    "commit",
    "--quiet",
    "-m",
    "Held local work",
  ]);
  const local = git(["-C", wt, "rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(wt, "held.txt"), "staged\n");
  git(["-C", wt, "add", "held.txt"]);
  fs.writeFileSync(path.join(wt, "held.txt"), "staged\nunstaged\n");
  fs.writeFileSync(path.join(wt, "dirty.txt"), "untracked bytes\n");
  const index = git([
    "-C",
    wt,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  ]);
  const before = fs.readFileSync(index);
  const refs = git(["-C", origin, "show-ref"]);
  return { wt, origin, local, index, before, refs };
}

export { git, heldCheckout };
