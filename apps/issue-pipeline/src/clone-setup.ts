// The git setup the code clone and the wiki clone share: gh credentials, the
// pipeline's git identity, and the pre-push hook that keeps agents from
// pushing.

import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
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
  const hook = path.join(clone, ".git", "hooks", "pre-push");
  fs.writeFileSync(hook, PRE_PUSH_HOOK);
  fs.chmodSync(hook, HOOK_MODE);
}

export { configureClone, GH_HELPER };
