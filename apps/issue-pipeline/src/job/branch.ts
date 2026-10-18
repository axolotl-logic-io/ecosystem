// The issue branch a stage job's caller assigns it (`--branch`): checked
// before the job claims, clones or changes anything. A branch is refused
// when git wouldn't take it literally as a branch name, or when it is one
// the repo protects: its configured base, its wiki's branch, or the remote's
// default branch. Whether the issue's saved state is bound to another branch
// is the claim's to refuse, since only it reads that state.

import { GH_HELPER } from "../clone-setup.ts";
import type { Config } from "../config.ts";
import { wikiCfg } from "../config.ts";
import { run } from "../process.ts";

// The symbolic HEAD line `git ls-remote --symref` prints.
const SYMREF_HEAD = /^ref: refs\/heads\/(?<name>\S+)\tHEAD$/mu;
// How long reading the remote's default branch may take.
const LS_REMOTE_MS = 60_000;

// Why `branch` isn't a branch name git takes as it is written, or null. `git
// check-ref-format --branch` expands `@{-1}` and similar, so a name it
// rewrites is refused too.
function syntaxRefusal(branch: string): string | null {
  if (branch.startsWith("-") || branch.startsWith("refs/")) {
    return `--branch ${branch} must be a plain branch name`;
  }
  if (branch === "HEAD") {
    return "--branch HEAD names no branch";
  }
  const checked = run("git", ["check-ref-format", "--branch", branch], {
    allowFail: true,
  });
  if (checked.code !== 0 || checked.stdout.trim() !== branch) {
    return `--branch ${branch} is not a valid branch name`;
  }
  return null;
}

// The remote's default branch, or null when it can't be read.
function remoteDefaultOf(cfg: Config): string | null {
  const url = cfg.cloneUrl || `https://github.com/${cfg.repo}.git`;
  const listed = run(
    "git",
    [...GH_HELPER, "ls-remote", "--symref", url, "HEAD"],
    {
      allowFail: true,
      timeoutMs: LS_REMOTE_MS,
    },
  );
  if (listed.code !== 0) {
    return null;
  }
  const { name } = SYMREF_HEAD.exec(listed.stdout)?.groups ?? {};
  return name ?? null;
}

// Why a job may not work on `branch`, or null when it may. With `remote` it
// also reads the remote's default branch, and refuses when it can't; without,
// it checks only what the config and git know locally.
function branchRefusalOf(
  cfg: Config,
  branch: string,
  remote: boolean,
): string | null {
  const syntax = syntaxRefusal(branch);
  if (syntax !== null) {
    return syntax;
  }
  const protectedNames = [cfg.baseBranch];
  const wiki = wikiCfg(cfg);
  if (wiki !== null) {
    protectedNames.push(wiki.branch);
  }
  if (protectedNames.includes(branch)) {
    return `--branch ${branch} is a protected branch of ${cfg.repo}`;
  }
  if (!remote) {
    return null;
  }
  const remoteDefault = remoteDefaultOf(cfg);
  if (remoteDefault === null) {
    return `can't read ${cfg.repo}'s default branch to check --branch ${branch}`;
  }
  if (remoteDefault === branch) {
    return `--branch ${branch} is ${cfg.repo}'s default branch`;
  }
  return null;
}

export { branchRefusalOf };
