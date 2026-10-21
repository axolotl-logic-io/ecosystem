// The issue branch a stage job's caller assigns it (`--branch`): checked
// before the job claims, clones or changes anything. A branch is refused
// when it isn't one an issue may work on (paths.branch in src/config.ts,
// which every op applies too: a literal branch name that isn't the
// configured base), when git would rewrite it as a branch name,
// or when it is the remote's default branch. Whether the issue's saved state
// is bound to another branch is the claim's to refuse, since only it reads
// that state.

import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import { git } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { run } from "../process.ts";

// The symbolic HEAD line `git ls-remote --symref` prints.
const SYMREF_HEAD = /^ref: refs\/heads\/(?<name>\S+)\tHEAD$/mu;
// How long reading the remote's default branch may take.
const LS_REMOTE_MS = 60_000;

// Why issue `issue` may not work on `branch` by the rule every op applies
// (paths.branch), or null. Past that rule, a name `git check-ref-format
// --branch` refuses or rewrites (it expands `@{-1}` and similar) is refused
// too.
function nameRefusal(
  cfg: Config,
  issue: number,
  branch: string,
): string | null {
  try {
    paths.branch(withCheckout(cfg, { issue, dir: "", branch }), issue);
  } catch (error: unknown) {
    if (error instanceof OpsError) {
      return `--branch: ${error.message}`;
    }
    throw error;
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
  const listed = git(cfg, "dev", ["ls-remote", "--symref", url, "HEAD"], {
    allowFail: true,
    timeoutMs: LS_REMOTE_MS,
  });
  if (listed.code !== 0) {
    return null;
  }
  const { name } = SYMREF_HEAD.exec(listed.stdout)?.groups ?? {};
  return name ?? null;
}

// Why a job on issue `issue` may not work on `branch`, or null when it may.
// With `remote` it also reads the remote's default branch, and refuses when
// it can't; without, it checks only what the config and git know locally.
function branchRefusalOf(
  cfg: Config,
  issue: number,
  branch: string,
  remote: boolean,
): string | null {
  const name = nameRefusal(cfg, issue, branch);
  if (name !== null) {
    return name;
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
