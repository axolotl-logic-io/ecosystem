// Small local-Git service fixture: no build, job, ops or model subprocesses.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { installFlowGh, openIssue } from "./fake-pipeline-flow-gh.ts";
import { pr } from "./fake-pipeline-flow-gh-prs.ts";
import type { World } from "./fake-pipeline-flow-gh-world.ts";
import { branchHead, readWorld } from "./fake-pipeline-flow-gh-world.ts";
import { git } from "./job-git-test-kit.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "flow-native-service-"));
const BASE = "integration";
const SOURCE = "feature";
const ISSUE = 7;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedNativeOrigin(origin: string, seed: string): string {
  git(["init", "--quiet", "--bare", "-b", BASE, origin]);
  git(["--git-dir", origin, "config", "core.logAllRefUpdates", "true"]);
  git(["init", "--quiet", "-b", SOURCE, seed]);
  fs.writeFileSync(path.join(seed, "code.txt"), "base\n");
  git(["-C", seed, "add", "."]);
  git(["-C", seed, "commit", "--quiet", "-m", "base"]);
  git(["-C", seed, "push", "--quiet", origin, `HEAD:refs/heads/${BASE}`]);
  const old = git(["-C", seed, "rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(seed, "code.txt"), "whole contribution\n");
  git(["-C", seed, "commit", "--quiet", "-am", "code"]);
  fs.mkdirSync(path.join(seed, "docs"));
  fs.writeFileSync(path.join(seed, "docs", "change.md"), "docs contribution\n");
  git(["-C", seed, "add", "docs"]);
  git([
    "-C",
    seed,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${old},module`,
  ]);
  git(["-C", seed, "commit", "--quiet", "-m", "docs and gitlink"]);
  git(["-C", seed, "push", "--quiet", origin, `HEAD:refs/heads/${SOURCE}`]);
  return old;
}

function nativeWorld(): {
  world: World;
  seed: string;
  old: string;
  head: string;
} {
  const dir = fs.mkdtempSync(path.join(ROOT, "world-"));
  const origin = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  const old = seedNativeOrigin(origin, seed);
  const bin = path.join(dir, "bin");
  const service = path.join(dir, "service");
  fs.mkdirSync(bin);
  installFlowGh({
    dir: service,
    bin,
    origin,
    repo: "o/r",
    account: "merge",
    collaborators: [],
    baseBranch: BASE,
  });
  openIssue(service, {
    number: ISSUE,
    title: "change",
    body: "",
    login: "alice",
  });
  const world = readWorld(service);
  pr(world, [
    "pr",
    "create",
    "--head",
    SOURCE,
    "--base",
    BASE,
    "--title",
    "change",
    "--body",
    `Closes #${ISSUE}`,
  ]);
  return { world, seed, old, head: String(branchHead(origin, SOURCE)) };
}

function pushTarget(
  { world, seed, old, head: authorized }: ReturnType<typeof nativeWorld>,
  head: string = authorized,
): void {
  git([
    "-C",
    seed,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "push.followTags=false",
    "push",
    "--quiet",
    `--force-with-lease=refs/heads/${BASE}:${old}`,
    world.origin,
    `${head}:refs/heads/${BASE}`,
  ]);
}

export { BASE, ISSUE, nativeWorld, pushTarget, SOURCE };
