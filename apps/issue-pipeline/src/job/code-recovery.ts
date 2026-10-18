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
  const temp = `${bundle}.tmp`;
  try {
    run("git", ["-C", repo, "bundle", "create", temp, "HEAD"]);
    run("git", ["-C", repo, "bundle", "verify", temp]);
    fs.renameSync(temp, bundle);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  const sha = run("git", ["-C", repo, "rev-parse", "HEAD"]).stdout.trim();
  process.stderr.write(
    `job: local code ${sha} saved for operator recovery in ${bundle}; nothing applies or pushes it automatically\n`,
  );
}

export { saveCodeRecovery };
