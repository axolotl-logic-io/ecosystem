// gh and git as the config's account, and who that account trusts. Reads that
// GitHub can safely repeat are retried through its transient failures; writes
// run once, with this machine's paths taken out of the text they post.

import type { Config } from "./config.ts";
import { tokenEnv } from "./config.ts";
import { redactLocalPaths } from "./pipeline-root.ts";
import type { RunOptions, RunResult } from "./process.ts";
import { OpsError, run, runFailure, sleepMs } from "./process.ts";

type GhOptions = Omit<RunOptions, "env">;

const WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u;
const GH_TRANSIENT =
  /HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Timeout|connection reset|TLS handshake timeout|i\/o timeout/iu;
// A stalled GitHub request once hung a sweep for 20 minutes, until the subagent
// timeout killed it. Callers may pass a longer timeoutMs.
const GH_TIMEOUT_MS = 120_000;
const GH_READ_ATTEMPTS = 4;
// The wait before retry n is n times this.
const GH_RETRY_STEP_MS = 2000;
const GH_ENV: ReadonlyMap<string, string> = new Map([
  ["GH_PROMPT_DISABLED", "1"],
]);
const GIT_ENV: ReadonlyMap<string, string> = new Map([
  ["GIT_TERMINAL_PROMPT", "0"],
  ["ISSUE_PIPELINE_OPS", "1"],
]);

// A read that GitHub can safely repeat: `list`/`view` subcommands, or `gh api`
// with no method or fields (a GET). Writes aren't retried, since a 502 may
// hide one that landed.
function ghIsRead(args: readonly string[]): boolean {
  if (args[0] === "api") {
    return !args.some((arg) => WRITE_FLAG.test(arg));
  }
  return args[1] === "list" || args[1] === "view";
}

// Only text arguments change (body=..., --body, --title); endpoints don't.
function redactGhArgs(args: readonly string[]): string[] {
  return args.map((arg, at) => {
    const flag = args[at - 1];
    if (arg.startsWith("body=") || flag === "--body" || flag === "--title") {
      return redactLocalPaths(arg);
    }
    return arg;
  });
}

function withEnv(
  ...maps: readonly ReadonlyMap<string, string>[]
): ReadonlyMap<string, string> {
  return new Map(maps.flatMap((map) => [...map]));
}

function retriable(result: RunResult, attempt: number): boolean {
  return (
    result.code !== 0 &&
    attempt < GH_READ_ATTEMPTS &&
    (result.timedOut || GH_TRANSIENT.test(result.stderr))
  );
}

function gh(
  cfg: Config,
  args: readonly string[],
  options: GhOptions = {},
): RunResult {
  const runOptions: RunOptions = {
    timeoutMs: GH_TIMEOUT_MS,
    ...options,
    env: withEnv(tokenEnv(cfg), GH_ENV),
  };
  if (!ghIsRead(args)) {
    return run("gh", redactGhArgs(args), runOptions);
  }
  // GitHub's API sometimes answers 502 or stalls; one failed read used to fail
  // a whole sweep.
  let attempt = 1;
  let result = run("gh", args, { ...runOptions, allowFail: true });
  while (retriable(result, attempt)) {
    sleepMs(GH_RETRY_STEP_MS * attempt);
    attempt += 1;
    result = run("gh", args, { ...runOptions, allowFail: true });
  }
  if (result.code === 0 || options.allowFail === true) {
    return result;
  }
  throw new OpsError(runFailure("gh", args, result, runOptions));
}

// gh's output read as JSON, or null when it printed nothing.
function ghJson(
  cfg: Config,
  args: readonly string[],
  options: GhOptions = {},
): unknown {
  const { stdout } = gh(cfg, args, options);
  if (stdout.trim() === "") {
    return null;
  }
  return JSON.parse(stdout);
}

// gh's output read as one JSON value per non-blank line.
function ghLines(
  cfg: Config,
  args: readonly string[],
  options: GhOptions = {},
): unknown[] {
  return gh(cfg, args, options)
    .stdout.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

function git(
  cfg: Config,
  args: readonly string[],
  options: GhOptions = {},
): RunResult {
  return run("git", args, {
    ...options,
    env: withEnv(tokenEnv(cfg), GIT_ENV),
  });
}

const collaborators = new Map<string, boolean>();

function isCollaborator(cfg: Config, login: string): boolean {
  const known = collaborators.get(login);
  if (known !== undefined) {
    return known;
  }
  const endpoint = `repos/${cfg.repo}/collaborators/${login}`;
  const result = gh(cfg, ["api", endpoint, "--silent"], { allowFail: true });
  const isOne = result.code === 0;
  collaborators.set(login, isOne);
  return isOne;
}

// A login counts only if it is on the config's allowedUsers (or is the account)
// and is still a collaborator, so removing someone from either stops trust.
function isAllowedUser(cfg: Config, login: string | null | undefined): boolean {
  if (login === undefined || login === null || login === "") {
    return false;
  }
  const allowed = new Set(
    [...cfg.allowedUsers, cfg.account].map((user) => user.toLowerCase()),
  );
  return allowed.has(login.toLowerCase()) && isCollaborator(cfg, login);
}

export { gh, ghIsRead, ghJson, ghLines, git, isAllowedUser, redactGhArgs };
