// The git setup of a code clone: the pipeline's git identity, the pre-push
// hook that keeps agents from pushing, and the pre-commit hook that keeps a
// stage job's sessions committing only through pipeline_commit.

import fs from "node:fs";
import path from "node:path";
import type { GitAccess } from "./checkout.ts";
import { run } from "./command.ts";

const PRE_PUSH_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_OPS" = 1 ] || { echo "Only the issue pipeline ops tool may push from this clone." >&2; exit 1; }\n';
const PRE_COMMIT_HOOK =
  '#!/bin/sh\n[ "$ISSUE_PIPELINE_COMMIT" = 1 ] || { echo "Commit with the pipeline_commit tool; git commit is refused in this checkout." >&2; exit 1; }\n';
interface CommitIdentity {
  name: string;
  email: string;
}

const HOOK_MODE = 0o755;

function gitIn(dir: string, args: readonly string[]): string {
  return run("git", ["-C", dir, ...args]).stdout;
}

// Sets the development commit identity and stops accidental agent pushes.
// Authentication is command-scoped, never a persistent credential helper.
// (--no-verify bypasses the hook, so it is a guard, not a boundary.)
function configureClone(identity: CommitIdentity, clone: string): void {
  gitIn(clone, ["config", "user.name", identity.name]);
  const { email } = identity;
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
// Only the configured GitHub repo can obtain command-scoped credentials.
function updateSubmodules(access: GitAccess, dir: string): void {
  access.run(["-C", dir, "submodule", "sync", "--recursive"]);
  access.run(["-C", dir, "submodule", "update", "--init", "--recursive"]);
}

export type { CommitIdentity };
export { configureClone, guardCommits, updateSubmodules, writeHook };
