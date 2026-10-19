// One selected operator credential per call, verified against its configured
// identity. Failures and allowFail outputs never expose that selected token.
import type { Config, Identity } from "./config.ts";
import { credential } from "./config.ts";
import { OpsError } from "./ops-error.ts";
import type { RunOptions, RunResult } from "./process.ts";
import { run, runFailure } from "./process.ts";

const GH_TIMEOUT_MS = 120_000;
const GH_ENV: ReadonlyMap<string, string> = new Map([
  ["GH_PROMPT_DISABLED", "1"],
  ["GH_HOST", "github.com"],
]);
const verified = new Set<string>();

function authenticatedEnv(
  cfg: Config,
  identity: Identity,
): ReadonlyMap<string, string> {
  const token = credential(cfg, identity);
  let account = cfg.mergeAccount;
  if (identity === "dev") {
    account = cfg.devAccount;
  }
  const key = JSON.stringify([account.toLowerCase(), token]);
  const env = new Map([...GH_ENV, ["GH_TOKEN", token]]);
  if (!verified.has(key)) {
    const login = credentialedRun("gh", ["api", "user", "--jq", ".login"], {
      env,
      allowFail: true,
      timeoutMs: GH_TIMEOUT_MS,
    });
    if (
      login.code !== 0 ||
      login.stdout.trim().toLowerCase() !== account.toLowerCase()
    ) {
      throw new OpsError(
        `credential login verification failed for ${identity}; expected @${account}`,
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

export { authenticatedEnv, credentialedRun, credentialFailure };
