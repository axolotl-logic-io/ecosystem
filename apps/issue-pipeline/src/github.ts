// gh and git as the explicitly selected bot, and who that account trusts. Reads that
// GitHub can safely repeat are retried through its transient failures; writes
// run once, with local paths and addresses redacted.

import { z } from "zod";
import type { Account, Config } from "./config.ts";
import { assertGitRemote, GIT_ENV, LOCAL_PATH } from "./git-remote.ts";
import {
  authenticatedEnv,
  credentialedRun,
  credentialFailure,
} from "./github-auth.ts";
import { GH_TIMEOUT_MS, githubRead } from "./github-read.ts";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { redactLocalPaths } from "./pipeline-root.ts";
import type { RunOptions, RunResult } from "./process.ts";
import { run, runFailure } from "./process.ts";
import { redactAddresses } from "./redact-addresses.ts";
import type { WriteIntent } from "./write-refusal.ts";

// `reconciles`: the write's own operation reconciles an uncertain result by
// reading, from a record it kept before the write (a push record, a Land
// attempt, a task record) or the PR its branch names, or the write is
// display only and safe to repeat, such as an issue assignment, so a lost
// answer leaves nothing to reconcile. Its ownership is still read fresh,
// but it isn't journaled (#169).
type GhOptions = Omit<RunOptions, "env"> & { reconciles?: boolean };

const WRITE_FLAG = /^(?:-X|--method|-f|-F|--field|--raw-field|--input)$/u;
// A read that GitHub can safely repeat: `list`/`view` subcommands, `pr
// checks`, or `gh api` with no method or fields (a GET). Writes aren't
// retried, since a 502 may hide one that landed.
function ghIsRead(args: readonly string[]): boolean {
  if (args[0] === "api" && args[1] === "graphql") {
    return args.some((arg) => arg.startsWith("query=query("));
  }
  if (args[0] === "api") {
    return !args.some((arg) => WRITE_FLAG.test(arg));
  }
  return (
    args[1] === "list" ||
    args[1] === "view" ||
    (args[0] === "pr" && args[1] === "checks")
  );
}

// Only text arguments change (body=..., --body, --title), losing local paths
// and IP addresses; endpoints are unchanged.
function redactGhArgs(args: readonly string[]): string[] {
  return args.map((arg, at) => {
    const flag = args[at - 1];
    if (arg.startsWith("body=") || flag === "--body" || flag === "--title") {
      return redactAddresses(redactLocalPaths(arg));
    }
    return arg;
  });
}

function withEnv(
  ...maps: readonly ReadonlyMap<string, string>[]
): ReadonlyMap<string, string> {
  return new Map(maps.flatMap((map) => [...map]));
}

function remoteOf(args: readonly string[], options: GhOptions): string {
  const clone = args.indexOf("clone");
  if (clone >= 0) {
    const remaining = args
      .slice(clone + 1)
      .filter((arg) => !arg.startsWith("-"));
    return remaining[0] ?? "";
  }
  const remote = args.indexOf("ls-remote");
  if (remote >= 0) {
    const target = args.slice(remote + 1).find((arg) => !arg.startsWith("-"));
    if (target !== undefined && target !== "origin") {
      return target;
    }
  }
  const at = args.indexOf("-C");
  const { cwd = "." } = options;
  let dir = cwd;
  if (at >= 0) {
    dir = args.at(at + 1) ?? cwd;
  }
  return run("git", ["config", "--get", "remote.origin.url"], {
    cwd: dir,
  }).stdout.trim();
}

// No persistent helper/keyring is consulted. The helper serves only this
// repository, only to github.com, and never stores a credential.
function gitHelper(cfg: Config): readonly string[] {
  const helper = `!f() { [ "$1" = get ] || exit 0; protocol= host= path=; while IFS== read -r key value; do case "$key" in protocol) protocol=$value;; host) host=$value;; path) path=$value;; esac; done; [ "$protocol" = https ] && [ "$host" = github.com ] || exit 1; case "$path" in ${cfg.repo}.git) printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN";; *) exit 1;; esac; }; f`;
  return [
    "-c",
    "credential.helper=",
    "-c",
    "credential.https://github.com.helper=",
    "-c",
    `credential.helper=${helper}`,
    "-c",
    "credential.useHttpPath=true",
    "-c",
    "http.extraHeader=",
    "-c",
    "http.https://github.com/.extraHeader=",
    "-c",
    "http.followRedirects=false",
  ];
}

// Task app writes pass through their stop check before reaching GitHub.
function controlledWrite(
  cfg: Config,
  intent: WriteIntent,
  write: () => RunResult,
  failure: {
    fail: (failed: RunResult) => OpsError;
    allowFail?: boolean | undefined;
  },
): RunResult {
  let result: RunResult;
  if (cfg.mutation === undefined) {
    result = write();
  } else {
    result = cfg.mutation(write, intent);
  }
  if (result.code !== 0 && failure.allowFail !== true) {
    throw failure.fail(result);
  }
  return result;
}

function gh(
  cfg: Config,
  identity: Account,
  args: readonly string[],
  options: GhOptions = {},
): RunResult {
  const { reconciles = false, ...given } = options;
  const runOptions: RunOptions = {
    timeoutMs: GH_TIMEOUT_MS,
    ...given,
    env: authenticatedEnv(cfg, identity),
  };
  if (!ghIsRead(args)) {
    const redacted = redactGhArgs(args);
    return controlledWrite(
      cfg,
      { command: "gh", args: redacted, journal: reconciles !== true },
      (): RunResult =>
        credentialedRun("gh", redacted, { ...runOptions, allowFail: true }),
      {
        fail: (failed: RunResult): OpsError =>
          credentialFailure("gh", redacted, failed, runOptions),
        allowFail: options.allowFail,
      },
    );
  }
  const { result } = githubRead(() =>
    credentialedRun("gh", args, { ...runOptions, allowFail: true }),
  );
  if (result.code === 0 || options.allowFail === true) {
    return result;
  }
  throw credentialFailure("gh", args, result, runOptions);
}

// gh's output read as JSON, or null when it printed nothing.
function ghJson(
  cfg: Config,
  identity: Account,
  args: readonly string[],
  options: GhOptions = {},
): unknown {
  const { stdout } = gh(cfg, identity, args, options);
  if (stdout.trim() === "") {
    return null;
  }
  return JSON.parse(stdout);
}

function ghLines(
  cfg: Config,
  identity: Account,
  args: readonly string[],
  options: GhOptions = {},
): unknown[] {
  return gh(cfg, identity, args, options)
    .stdout.split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}

const ISSUE_STATE = z.looseObject({ state: z.unknown() }).nullable();

// The issue's state on GitHub ("open" or "closed"), or null when GitHub's
// answer can't be read.
function issueState(cfg: Config, n: number): string | null {
  const args = ["api", `repos/${cfg.repo}/issues/${n}`, "--jq", "{state}"];
  const parsed = ISSUE_STATE.safeParse(
    ghJson(cfg, "landing", args, { allowFail: true }),
  );
  const state = parsed.data?.state;
  if (typeof state !== "string") {
    return null;
  }
  return state;
}

function git(
  cfg: Config,
  identity: Account,
  args: readonly string[],
  options: GhOptions = {},
): RunResult {
  if (args.includes("push") && cfg.mutation !== undefined) {
    const { mutation: _mutation, ...transport } = cfg;
    const { reconciles = false, ...given } = options;
    return controlledWrite(
      cfg,
      { command: "git", args, journal: reconciles !== true },
      (): RunResult =>
        git(transport, identity, args, { ...given, allowFail: true }),
      {
        fail: (failed: RunResult): OpsError =>
          new OpsError(runFailure("git", args, failed, given)),
        allowFail: options.allowFail,
      },
    );
  }
  const remote = remoteOf(args, options);
  if (LOCAL_PATH.test(remote)) {
    // Local test origins and mirrors never need or receive a credential.
    return run("git", args, {
      ...options,
      env: GIT_ENV,
    });
  }
  assertGitRemote(cfg, remote);
  const helper = gitHelper(cfg);
  return credentialedRun("git", [...helper, ...args], {
    ...options,
    env: withEnv(
      cfg.gitAccount?.env ?? authenticatedEnv(cfg, identity),
      GIT_ENV,
    ),
  });
}

// Failed authority reads hold requirements instead of silently removing a
// previously trusted person's input from its revision digest. This includes
// unreadable 404 responses, which cannot establish the reader's capability.
function assertCollaborator(cfg: Config, login: string): void {
  const endpoint = `repos/${cfg.repo}/collaborators/${login}`;
  const result = gh(cfg, "landing", ["api", endpoint, "--silent"], {
    allowFail: true,
  });
  if (result.code !== 0) {
    throw new OpsError(
      `cannot establish current collaborator authority for @${login}; hold trusted requirements until the read is verified`,
    );
  }
}

// A human login counts only if explicitly allowed, never either bot,
function isAllowedUser(cfg: Config, login: string | null | undefined): boolean {
  if (login === undefined || login === null || login === "") {
    return false;
  }
  const normalized = login.toLowerCase();
  if (
    [cfg.devAccount, cfg.landingAccount].some(
      (bot) => bot.toLowerCase() === normalized,
    )
  ) {
    return false;
  }
  const allowed = new Set(cfg.allowedUsers.map((user) => user.toLowerCase()));
  if (!allowed.has(normalized)) {
    return false;
  }
  assertCollaborator(cfg, login);
  return true;
}

export {
  gh,
  ghIsRead,
  ghJson,
  ghLines,
  git,
  isAllowedUser,
  issueState,
  redactGhArgs,
};
