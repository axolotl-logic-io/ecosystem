// One selected operator credential per call, verified against its configured
// identity. Failures and allowFail outputs never expose that selected token.

import {
  GH_TIMEOUT_MS,
  githubRead,
  transientGithubRead,
} from "@ecosystem/task-runtime/issue/github-read";
import { credentialedRun } from "@ecosystem/task-runtime/issue/transport";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import type { Account, Config } from "./config.ts";
import { credential } from "./config.ts";
import type { RunResult } from "./process.ts";

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

export { authenticatedEnv, LOGIN_STDERR_LIMIT };
