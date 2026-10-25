import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Delivery, Result, ReviewTool } from "../../src/job/git-review.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";

const { gitEnvironment }: typeof import("../../src/job/git-review-process.ts") =
  await import("../../src/job/git-review-process.ts");
const FIXTURE_TIMEOUT_MS = 10_000;
const { reviewer }: typeof import("../../src/job/git-review.ts") = await import(
  "../../src/job/git-review.ts"
);

const QUERIES = [
  ["diff", "HEAD~1", "HEAD"],
  ["show", "HEAD"],
  ["log", "--oneline", "--max-count=2"],
  ["rev-parse", "--verify", "HEAD"],
  ["merge-base", "HEAD~1", "HEAD"],
  ["ls-tree", "-r", "HEAD"],
  ["cat-file", "-p", "HEAD:file.txt"],
  ["status", "--porcelain"],
  ["blame", "--line-porcelain", "HEAD", "--", "file.txt"],
  ["grep", "-n", "-e", "line", "HEAD", "--", "file.txt"],
];

function git(repo: string, argv: string[]): string {
  const home = path.join(isolatedRoot, "git-home");
  fs.mkdirSync(home, { recursive: true });
  const result = spawnSync("/usr/bin/git", argv, {
    cwd: repo,
    env: {
      ...gitEnvironment(home),
      ...Object.fromEntries([
        ["GIT_AUTHOR_NAME", "Test"],
        ["GIT_AUTHOR_EMAIL", "test@example.invalid"],
        ["GIT_COMMITTER_NAME", "Test"],
        ["GIT_COMMITTER_EMAIL", "test@example.invalid"],
      ]),
    },
    encoding: "utf8",
    timeout: FIXTURE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

function fixture(): { repo: string; tool: ReviewTool } {
  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(isolatedRoot, "git-repo-")),
  );
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "first line\n");
  fs.writeFileSync(path.join(repo, "empty.txt"), "");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "first"]);
  fs.appendFileSync(path.join(repo, "file.txt"), "second line\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "second"]);
  return { repo, tool: reviewer(JSON.stringify([repo])) };
}

function query(
  tool: ReviewTool,
  repo: string,
  argv: string[],
  page: { offset?: number; limit?: number } = {},
): Promise<Result> {
  return tool.execute("call", { cwd: repo, argv, ...page });
}

function delivery(result: Result): Delivery {
  if (result.isError === true || !("queryId" in result.details)) {
    throw new Error(JSON.stringify(result));
  }
  return result.details;
}

function pageLines(result: Result): string[] {
  const text = result.content[0]?.text;
  if (text === undefined) {
    throw new Error("Missing page text");
  }
  const [, ...lines] = text.split("\n");
  if (lines.at(-1) === "=== END ===") {
    lines.pop();
  }
  if (delivery(result).totalLines === 0) {
    return [];
  }
  return lines;
}

function snapshot(dir: string): string {
  const hash = createHash("sha256");
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    hash.update(name);
    const info = fs.lstatSync(file);
    if (info.isDirectory()) {
      hash.update(snapshot(file));
    } else if (info.isSymbolicLink()) {
      hash.update(fs.readlinkSync(file));
    } else {
      hash.update(fs.readFileSync(file));
    }
  }
  return hash.digest("hex");
}

//  Union for exactly one tool-owned cached query, not a reviewer assertion.
function coveredLines(records: Delivery[], assigned: Delivery): Set<number> {
  const covered = new Set<number>();
  for (const record of records) {
    if (
      record.sessionId === assigned.sessionId &&
      record.queryId === assigned.queryId &&
      record.repository === assigned.repository &&
      JSON.stringify(record.argv) === JSON.stringify(assigned.argv) &&
      record.startLine !== null &&
      record.endLine !== null
    ) {
      for (let line = record.startLine; line <= record.endLine; line += 1) {
        covered.add(line);
      }
    }
  }
  return covered;
}

function syntheticEnvironment(host: string): Record<string, string> {
  return Object.fromEntries([
    ["HOME", host],
    ["GH_TOKEN", "synthetic-gh"],
    ["GITHUB_TOKEN", "synthetic-github"],
    ["ROLE_GITHUB_TOKEN", "synthetic-role"],
    ["SSH_AUTH_SOCK", "/sentinel-agent"],
    ["GIT_CONFIG_COUNT", "1"],
    ["GIT_CONFIG_KEY_0", "core.fsmonitor"],
    ["GIT_CONFIG_VALUE_0", "sentinel"],
    ["GIT_CONFIG_PARAMETERS", "sentinel"],
    ["GIT_ASKPASS", "sentinel"],
    ["SSH_ASKPASS", "sentinel"],
    ["GIT_EXEC_PATH", "/sentinel-bin"],
    ["GIT_DIR", "/outside"],
    ["GIT_OBJECT_DIRECTORY", "/outside"],
    ["GIT_EXTERNAL_DIFF", "sentinel"],
    ["GIT_CONFIG_GLOBAL", path.join(host, ".gitconfig")],
  ]);
}

//  Run ordered requests without artificial parallel Git load.
function eachAsync<T>(
  values: T[],
  check: (value: T) => Promise<void>,
): Promise<void> {
  return values.reduce(async (previous, value) => {
    await previous;
    await check(value);
  }, Promise.resolve());
}

function readAll(
  tool: ReviewTool,
  repo: string,
  argv: string[],
  limit: number,
): Promise<Result[]> {
  async function next(offset: number): Promise<Result[]> {
    const result = await query(tool, repo, argv, { offset, limit });
    const record = delivery(result);
    if (record.endLine === null || record.endLine === record.totalLines) {
      return [result];
    }
    return [result, ...(await next(record.endLine + 1))];
  }
  return next(1);
}

export {
  coveredLines,
  delivery,
  eachAsync,
  fixture,
  git,
  pageLines,
  QUERIES,
  query,
  readAll,
  snapshot,
  syntheticEnvironment,
};
