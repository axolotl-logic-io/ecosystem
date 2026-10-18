// The git setup the code clone and the wiki clone share: gh credentials, the
// pipeline's git identity, and the pre-push hook that keeps agents from
// pushing; and the pre-commit hook that keeps a stage job's sessions
// committing only through pipeline_commit.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { git } from "./github.ts";
import { run } from "./process.ts";

const CREDENTIAL_HELPER = "credential.https://github.com.helper";
// Arguments that make one git command authenticate through gh, for commands
// such as clone that run before configureClone can.
const GH_HELPER: readonly string[] = [
  "-c",
  `${CREDENTIAL_HELPER}=`,
  "-c",
  `${CREDENTIAL_HELPER}=!gh auth git-credential`,
];
const PRE_PUSH_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_OPS" = 1 ] || { echo "Only the issue pipeline ops tool may push from this clone." >&2; exit 1; }\n';
const PRE_COMMIT_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_COMMIT" = 1 ] || { echo "Commit with the pipeline_commit tool; git commit is refused in this checkout." >&2; exit 1; }\n';
const HOOK_MODE = 0o755;

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// Authenticates git through gh, using the token from the ops environment when
// there is one, and stops agents pushing by accident: only this tool pushes.
// (--no-verify bypasses the hook, so it is a guard, not a boundary.)
function configureClone(cfg: Config, clone: string): void {
  run("git", ["-C", clone, "config", "--unset-all", CREDENTIAL_HELPER], {
    allowFail: true,
  });
  gitIn(clone, ["config", "--add", CREDENTIAL_HELPER, ""]);
  gitIn(clone, [
    "config",
    "--add",
    CREDENTIAL_HELPER,
    "!gh auth git-credential",
  ]);
  gitIn(clone, ["config", "user.name", cfg.gitName || cfg.account]);
  const email = cfg.gitEmail || `${cfg.account}@users.noreply.github.com`;
  gitIn(clone, ["config", "user.email", email]);
  writeHook(clone, "pre-push", PRE_PUSH_HOOK);
}

function writeHook(clone: string, name: string, script: string): void {
  const gitDir = gitIn(clone, ["rev-parse", "--absolute-git-dir"]).trim();
  const hook = path.join(gitDir, "hooks", name);
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, script);
  fs.chmodSync(hook, HOOK_MODE);
}

// Refuses commits in `clone` unless ISSUE_PIPELINE_COMMIT=1, which
// pipeline_commit and the ops' own commits set. (--no-verify bypasses it,
// and pipeline_commit refuses that flag, so it too is a guard.)
function guardCommits(clone: string): void {
  writeHook(clone, "pre-commit", PRE_COMMIT_HOOK);
}

// Fetches the submodule commits recorded by this checkout, recursively.
// Command-scoped credentials also reach private and nested submodules.
function updateSubmodules(cfg: Config, dir: string): void {
  git(cfg, [...GH_HELPER, "-C", dir, "submodule", "sync", "--recursive"]);
  git(cfg, [
    ...GH_HELPER,
    "-C",
    dir,
    "submodule",
    "update",
    "--init",
    "--recursive",
  ]);
}

export { configureClone, GH_HELPER, guardCommits, updateSubmodules };
