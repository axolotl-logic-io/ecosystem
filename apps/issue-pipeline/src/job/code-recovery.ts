// Local code that cannot be pushed is operator work, not disposable state.
// A self-contained bundle retains HEAD and its history independently of both
// the disposable checkout and mutable remote refs. Nothing replays it.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { git } from "../github.ts";
import { run } from "../process.ts";
import { saveDroppedPatch } from "./dropped-patch.ts";

// An independently verifiable bundle, installed without overwriting evidence.
function saveBundle(
  repo: string,
  bundle: string,
  refs: readonly string[],
): void {
  const tempDir = fs.mkdtempSync(path.join(path.dirname(bundle), "bundle-"));
  const temp = path.join(tempDir, "commits.bundle");
  try {
    run("git", ["-C", repo, "bundle", "create", temp, ...refs]);
    run("git", ["-C", repo, "bundle", "verify", temp]);
    fs.linkSync(temp, bundle);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Before abort/reset/clean, keep index/worktree patches and every local branch,
// current HEAD and available pre-rebase head. Unmerged indexes refuse cleanup:
// the original checkout, including conflict stages, is the recovery artifact.
function saveSyncRecovery(cfg: Config, issue: number, repo: string): void {
  const root = path.join(paths.runDir(cfg, issue), "recovery");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "sync-"));
  saveDroppedPatch(cfg, repo, {
    file: path.join(dir, "working.patch"),
    title: "Work retained before synchronization cleanup",
  });
  const refs = ["HEAD", "--branches"];
  const original = run(
    "git",
    ["-C", repo, "rev-parse", "--verify", "--quiet", "ORIG_HEAD"],
    { allowFail: true },
  );
  if (original.code === 0) {
    refs.push("ORIG_HEAD");
  }
  saveBundle(repo, path.join(dir, "commits.bundle"), refs);
}

function saveCodeRecovery(
  cfg: Config,
  issue: number,
  repo: string,
  key: string,
): void {
  if (!fs.existsSync(path.join(repo, ".git"))) {
    return;
  }
  try {
    git(cfg, ["-C", repo, "fetch", "--quiet", "--prune", "origin"]);
    const count = run("git", [
      "-C",
      repo,
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--remotes=origin",
    ]);
    if (Number(count.stdout.trim()) === 0) {
      return;
    }
  } catch {
    // An unreachable remote is not proof that all commits are safe there.
  }
  const dir = path.join(paths.runDir(cfg, issue), "recovery");
  fs.mkdirSync(dir, { recursive: true });
  const bundle = path.join(dir, `${key}-code.bundle`);
  saveBundle(repo, bundle, ["HEAD"]);
  const sha = run("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.trim();
  process.stderr.write(
    `job: local code ${sha} saved for operator recovery in ${bundle}; nothing applies or pushes it automatically\n`,
  );
}

export { saveCodeRecovery, saveSyncRecovery };
