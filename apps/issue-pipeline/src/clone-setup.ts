// Checkout preparation shared by legacy worktrees and job-mode clones:
// git identity and guarded commits/pushes, submodules, and the configured
// repository setup that provisions each issue's local test environment.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "./config.ts";
import { paths } from "./config.ts";
import { git } from "./github.ts";
import { issueEnvironment } from "./issue-environment.ts";
import type { ShellResult } from "./process.ts";
import { run, shell } from "./process.ts";

const PRE_PUSH_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_OPS" = 1 ] || { echo "Only the issue pipeline ops tool may push from this clone." >&2; exit 1; }\n';
const PRE_COMMIT_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_COMMIT" = 1 ] || { echo "Commit with the pipeline_commit tool; git commit is refused in this checkout." >&2; exit 1; }\n';
const HOOK_MODE = 0o755;

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// Sets the development commit identity and stops accidental agent pushes.
// Authentication is command-scoped, never a persistent credential helper.
// (--no-verify bypasses the hook, so it is a guard, not a boundary.)
function configureClone(cfg: Config, clone: string): void {
  gitIn(clone, ["config", "user.name", cfg.gitName || cfg.devAccount]);
  const email = cfg.gitEmail || `${cfg.devAccount}@users.noreply.github.com`;
  gitIn(clone, ["config", "user.email", email]);
  writeHook(clone, "pre-push", PRE_PUSH_HOOK);
}

// Writes git hook `name` of `clone`. A worktree's hooks are its clone's,
// so one written from a worktree runs in every worktree of that clone.
function writeHook(clone: string, name: string, script: string): void {
  const hooks = gitIn(clone, ["rev-parse", "--git-path", "hooks"]).trim();
  const hook = path.resolve(clone, hooks, name);
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
// Only the configured GitHub repo/wiki can obtain command-scoped credentials.
function updateSubmodules(cfg: Config, dir: string): void {
  git(cfg, "dev", ["-C", dir, "submodule", "sync", "--recursive"]);
  git(cfg, "dev", ["-C", dir, "submodule", "update", "--init", "--recursive"]);
}

const MS_PER_MINUTE = 60_000;
// The config keys setUpCheckout reads; loadConfig applied their defaults.
const SETUP_SETTINGS = z.looseObject({
  commandTimeoutMinutes: z.number(),
  commands: z.looseObject({ setup: z.string().nullish() }),
});

// Runs the repo's setup command (config `commands.setup`), if it sets one,
// in issue `n`'s checkout `dir`, so the writer's own test runs get this
// issue's database and ports instead of the shared defaults. It writes the
// command's output to `logName` in the issue's run folder. Returns null
// without configured setup; callers must surface failures to role sessions.
function setUpCheckout(
  cfg: Config,
  n: number,
  dir: string,
  logName: string,
): ShellResult | null {
  const { commandTimeoutMinutes, commands } = SETUP_SETTINGS.parse(cfg);
  const { setup } = commands;
  if (setup === undefined || setup === null || setup === "") {
    return null;
  }
  const log = path.join(paths.runDir(cfg, n), logName);
  return shell(setup, dir, log, {
    timeoutMs: commandTimeoutMinutes * MS_PER_MINUTE,
    env: issueEnvironment(cfg, n),
  });
}

export {
  configureClone,
  guardCommits,
  setUpCheckout,
  updateSubmodules,
  writeHook,
};
