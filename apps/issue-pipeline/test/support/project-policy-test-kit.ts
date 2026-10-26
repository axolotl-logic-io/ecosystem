// Committed project settings for test configs: a policy clone of `origin`
// whose one commit holds `.issue-pipeline.json`, pinned as the operator
// config's `projectPolicy`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface PolicyPin {
  repository: string;
  revision: string;
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Commits `settings` as `.issue-pipeline.json` in a new clone at `dir`
// whose origin is `origin`, and returns the pin of that commit.
function committedPolicy(
  dir: string,
  origin: string,
  settings: Readonly<Record<string, unknown>>,
): PolicyPin {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.name", "Policy test"]);
  git(dir, ["config", "user.email", "policy@example.test"]);
  git(dir, ["remote", "add", "origin", origin]);
  fs.writeFileSync(
    path.join(dir, ".issue-pipeline.json"),
    JSON.stringify(settings),
  );
  git(dir, ["add", ".issue-pipeline.json"]);
  git(dir, ["commit", "--quiet", "-m", "Pin settings"]);
  return { repository: dir, revision: git(dir, ["rev-parse", "HEAD"]) };
}

export type { PolicyPin };
export { committedPolicy };
