// Synthetic policy repository and operator config; no credential file is read.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { credentialConfig } from "./credentials-test-kit.ts";
import { isolatedRoot } from "./isolated-root-test-kit.ts";

const { PATH: systemPath }: NodeJS.ProcessEnv = process.env;

function git(dir: string, args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: Object.fromEntries([
      ["HOME", isolatedRoot],
      ["PATH", systemPath ?? ""],
      ["GIT_CONFIG_NOSYSTEM", "1"],
      ["GIT_CONFIG_GLOBAL", "/dev/null"],
      ["GIT_AUTHOR_NAME", "test"],
      ["GIT_AUTHOR_EMAIL", "test@example.invalid"],
      ["GIT_COMMITTER_NAME", "test"],
      ["GIT_COMMITTER_EMAIL", "test@example.invalid"],
    ]),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

function policyFixture(
  settings: unknown = { commands: { test: "printf checked" } },
): {
  dir: string;
  file: string;
  revision: string;
  operator: Record<string, unknown>;
  save: (changes?: Record<string, unknown>) => void;
} {
  const dir = fs.mkdtempSync(path.join(isolatedRoot, "policy-"));
  git(dir, ["init", "--quiet"]);
  git(dir, ["remote", "add", "origin", "https://github.com/example/repo.git"]);
  fs.writeFileSync(
    path.join(dir, ".issue-pipeline.json"),
    JSON.stringify(settings),
  );
  git(dir, ["add", ".issue-pipeline.json"]);
  git(dir, ["commit", "--quiet", "-m", "trusted policy"]);
  const revision = git(dir, ["rev-parse", "HEAD"]);
  const file = path.join(dir, "operator.json");
  const operator = {
    repo: "example/repo",
    ...credentialConfig("merge-bot"),
    allowedUsers: ["owner"],
    projectPolicy: { repository: dir, revision },
  };
  function save(changes: Record<string, unknown> = {}): void {
    fs.writeFileSync(file, JSON.stringify({ ...operator, ...changes }));
  }
  save();
  return { dir, file, revision, operator, save };
}

export { git, policyFixture };
