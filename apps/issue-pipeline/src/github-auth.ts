// One selected operator credential per call, verified against its configured
// identity. Failures and allowFail outputs never expose that selected token.
import type { Account, Config } from "./config.ts";
import { credential } from "./config.ts";
import {
  GH_TIMEOUT_MS,
  githubRead,
  transientGithubRead,
} from "./github-read.ts";
import { OpsError } from "./ops-error.ts";
import type { RunOptions, RunResult } from "./process.ts";
import { run, runFailure } from "./process.ts";

// The entire stderr field, including its truncation indicator, is at most
// 1024 UTF-16 code units. credentialedRun redacts before this limit is applied.
const LOGIN_STDERR_LIMIT = 1024;
const TRUNCATED = "… [truncated]";
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/iu;
const AUTH_REJECTED = /\bHTTP 401\b|\bstatus[ :]+401\b/iu;

function observedLogin(result: RunResult): string | null {
  const login = result.stdout.trim();
  if (LOGIN.test(login)) {
    return login;
  }
  return null;
}

function authenticationRejected(result: RunResult): boolean {
  return AUTH_REJECTED.test(`${result.stderr}\n${result.stdout}`);
}

function loginStderr(stderr: string): string {
  if (stderr === "") {
    return "<empty>";
  }
  if (stderr.length > LOGIN_STDERR_LIMIT) {
    return stderr.slice(0, LOGIN_STDERR_LIMIT - TRUNCATED.length) + TRUNCATED;
  }
  return stderr;
}
const GH_ENV: ReadonlyMap<string, string> = new Map([
  ["GH_PROMPT_DISABLED", "1"],
  ["GH_HOST", "github.com"],
]);
const verified = new Set<string>();

function authenticatedEnv(
  cfg: Config,
  identity: Account,
): ReadonlyMap<string, string> {
  const token = credential(cfg, identity);
  let account = cfg.landingAccount;
  if (identity === "dev") {
    account = cfg.devAccount;
  }
  const key = JSON.stringify([account.toLowerCase(), token]);
  const env = new Map([...GH_ENV, ["GH_TOKEN", token]]);
  if (!verified.has(key)) {
    const { result, attempts } = githubRead(
      () =>
        credentialedRun("gh", ["api", "user", "--jq", ".login"], {
          env,
          allowFail: true,
          timeoutMs: GH_TIMEOUT_MS,
        }),
      (login) => {
        const observed = observedLogin(login);
        return (
          (observed === null ||
            observed.toLowerCase() === account.toLowerCase()) &&
          !authenticationRejected(login) &&
          transientGithubRead(login)
        );
      },
    );
    const observed = observedLogin(result);
    let failure: string | null = null;
    if (observed !== null && observed.toLowerCase() !== account.toLowerCase()) {
      failure = `wrong account: observed @${observed}`;
    } else if (authenticationRejected(result)) {
      failure = "authentication rejected (HTTP 401)";
    } else if (result.code !== 0 || observed === null) {
      failure = `unverifiable after ${attempts} attempts`;
    }
    if (failure !== null) {
      throw new OpsError(
        `credential login verification failed for ${identity}; expected @${account}; ${failure}; gh exit status ${result.code}; stderr: ${loginStderr(result.stderr)}`,
      );
    }
    verified.add(key);
  }
  return env;
}

function credentialedRun(
  cmd: string,
  args: readonly string[],
  options: RunOptions,
): RunResult {
  const token = options.env?.get("GH_TOKEN") ?? "";
  const result = run(cmd, args, { ...options, allowFail: true });
  const out = {
    ...result,
    stdout: result.stdout.replaceAll(token, "<token>"),
    stderr: result.stderr.replaceAll(token, "<token>"),
  };
  if (out.code !== 0 && options.allowFail !== true) {
    throw credentialFailure(cmd, args, out, options);
  }
  return out;
}

function credentialFailure(
  cmd: string,
  args: readonly string[],
  result: RunResult,
  options: RunOptions,
): OpsError {
  const token = options.env?.get("GH_TOKEN");
  const failure = runFailure(cmd, args, result, options);
  if (token === undefined) {
    return new OpsError(failure);
  }
  return new OpsError(failure.replaceAll(token, "<token>"));
}

export {
  authenticatedEnv,
  credentialedRun,
  credentialFailure,
  LOGIN_STDERR_LIMIT,
};
