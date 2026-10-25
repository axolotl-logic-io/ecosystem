// What the implementor's resolver task allows, run against real git in a
// checkout guarded as the job's are (`guardCommits`): `git commit` is
// refused, while staging the resolved files and `GIT_EDITOR=true git rebase
// --continue` replay every stopped commit of a conflicted rebase, so the
// resolver needs no commit of its own and no hook bypass.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { endsWithTest } from "../../bounded-test-kit.ts";
import { TEMPORARY_ROOT } from "../implementor-test-kit.ts";

const { guardCommits }: typeof import("../../../src/clone-setup.ts") =
  await import("../../../src/clone-setup.ts");

// The pipeline runs its commands from its root, which the kit only names.
fs.mkdirSync(TEMPORARY_ROOT, { recursive: true });

const GIT_TIMEOUT_MS = 10_000;
const COMMIT_REFUSED = /git commit is refused in this checkout/u;
const GIT_VARIABLE = /^GIT_/u;

// The tests' git sees no outer repo's variables and no pipeline commit
// permission, as a session's shell in a job checkout doesn't.
const GIT_ENV = Object.fromEntries([
  ...Object.entries(process.env).filter(
    ([name]) => !(GIT_VARIABLE.test(name) || name === "ISSUE_PIPELINE_COMMIT"),
  ),
  ["GIT_CONFIG_NOSYSTEM", "1"],
  ["GIT_AUTHOR_NAME", "Fixture"],
  ["GIT_AUTHOR_EMAIL", "fixture@example.invalid"],
  ["GIT_COMMITTER_NAME", "Fixture"],
  ["GIT_COMMITTER_EMAIL", "fixture@example.invalid"],
]);

// Runs git in `dir`, bounded, and returns how it ended.
// env: more environment, as entries
function git(
  dir: string,
  args: string[],
  env: [string, string][] = [],
): { status: number | null; out: string; err: string } {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: { ...GIT_ENV, ...Object.fromEntries(env) },
    timeout: GIT_TIMEOUT_MS,
  });
  return { status: result.status, out: result.stdout, err: result.stderr };
}

// Runs git in `dir` and fails the test unless it succeeds.
function gitOk(dir: string, args: string[]): string {
  const result = git(dir, args);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.err}`);
  }
  return result.out.trim();
}

// Commits `text` as a.txt in `dir`, before the checkout is guarded.
function commitFile(dir: string, text: string, message: string): void {
  fs.writeFileSync(path.join(dir, "a.txt"), text);
  gitOk(dir, ["add", "--", "a.txt"]);
  gitOk(dir, ["commit", "-q", "-m", message]);
}

// A guarded repo whose issue branch has two commits that each conflict
// with main.
function conflictedRepo(): string {
  const place = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-git-"));
  endsWithTest(() => fs.rmSync(place, { recursive: true, force: true }));
  const repo = path.join(place, "repo");
  fs.mkdirSync(repo);
  gitOk(repo, ["init", "-q", "-b", "main"]);
  commitFile(repo, "base\n", "Base");
  gitOk(repo, ["checkout", "-q", "-b", "issue"]);
  commitFile(repo, "issue one\n", "Issue one");
  commitFile(repo, "issue two\n", "Issue two");
  gitOk(repo, ["checkout", "-q", "main"]);
  commitFile(repo, "main\n", "Main");
  gitOk(repo, ["checkout", "-q", "issue"]);
  guardCommits(repo);
  return repo;
}

// Resolves the stopped commit as `text`, the way the resolver task says.
function resolveAndContinue(
  repo: string,
  text: string,
): { status: number | null; out: string; err: string } {
  fs.writeFileSync(path.join(repo, "a.txt"), text);
  gitOk(repo, ["add", "--", "a.txt"]);
  return git(repo, ["rebase", "--continue"], [["GIT_EDITOR", "true"]]);
}

test("a guarded checkout refuses git commit", () => {
  const repo = conflictedRepo();
  fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
  gitOk(repo, ["add", "--", "b.txt"]);
  const commit = git(repo, ["commit", "-m", "Mine"]);
  assert.notEqual(commit.status, 0);
  assert.match(commit.err, COMMIT_REFUSED);
  assert.equal(gitOk(repo, ["log", "-1", "--format=%s"]), "Issue two");
});

test("staging and rebase --continue replay each stopped commit in a guarded checkout", () => {
  const repo = conflictedRepo();
  const main = gitOk(repo, ["rev-parse", "main"]);
  const rebase = git(repo, ["rebase", "main"]);
  assert.notEqual(rebase.status, 0, "the rebase stops on the conflict");
  const first = resolveAndContinue(repo, "main\nissue one\n");
  assert.notEqual(first.status, 0, "the second commit stops too");
  assert.equal(gitOk(repo, ["log", "-1", "--format=%s"]), "Issue one");
  const second = resolveAndContinue(repo, "main\nissue two\n");
  assert.equal(second.status, 0, second.err);
  const rebaseDir = gitOk(repo, ["rev-parse", "--git-path", "rebase-merge"]);
  assert.ok(!fs.existsSync(path.resolve(repo, rebaseDir)));
  assert.equal(
    gitOk(repo, ["log", "--format=%s", "main..HEAD"]),
    "Issue two\nIssue one",
  );
  assert.equal(gitOk(repo, ["merge-base", "HEAD", "main"]), main);
  const resolved = fs.readFileSync(path.join(repo, "a.txt"), "utf8");
  assert.equal(resolved, "main\nissue two\n");
  assert.equal(gitOk(repo, ["status", "--porcelain"]), "");
});
