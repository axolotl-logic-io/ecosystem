// Starts a task program the way the launcher does: `TASK.mjs --invocation`
// with the invocation on stdin and the buddy's verified credentials on
// fd 3. Both channels are private files in `options.dir`, written before
// the child starts, so a caller that then blocks its event loop, as a gate
// wait does, cannot starve them. The caller reads the child's stderr and
// awaits its exit.
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PRIVATE = 0o600;

// The run to invoke: the task, its issue, the repository config and base
// the buddy's scope gives, and the account with its token.
interface Invocation {
  program: string;
  task: string;
  repo: string;
  issue: number;
  config: string;
  base: string;
  claimWaitsMs: number[];
  account: string;
  token: string;
  // The buddy's credential variable, which the program hides from children.
  variable: string;
}

// Writes `value` as JSON to a new private file in `dir` and opens it.
function channel(dir: string, value: unknown): number {
  const file = path.join(dir, `invocation-${randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(value), { mode: PRIVATE });
  return fs.openSync(file, "r");
}

function invokeTaskApp(
  invocation: Invocation,
  options: { env: NodeJS.ProcessEnv; dir: string; cwd?: string },
): ChildProcess {
  const input = channel(options.dir, {
    version: 1,
    task: invocation.task,
    issue: { repo: invocation.repo, number: invocation.issue },
    settings: {
      config: invocation.config,
      base: invocation.base,
      claimWaitsMs: invocation.claimWaitsMs,
    },
    account: invocation.account,
  });
  const credentials = channel(options.dir, {
    account: invocation.account,
    env: [
      ["GH_PROMPT_DISABLED", "1"],
      ["GH_HOST", "github.com"],
      ["GH_TOKEN", invocation.token],
    ],
    hiddenVariables: [invocation.variable],
  });
  try {
    return spawn(process.execPath, [invocation.program, "--invocation"], {
      cwd: options.cwd,
      env: options.env,
      stdio: [input, "ignore", "pipe", credentials],
    });
  } finally {
    fs.closeSync(input);
    fs.closeSync(credentials);
  }
}

export type { Invocation };
export { invokeTaskApp };
