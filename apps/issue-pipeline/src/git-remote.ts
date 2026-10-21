// Credentialed Git destinations and the native push's observed URL binding.
import type { Config } from "./config.ts";
import { OpsError } from "./ops-error.ts";
import { run } from "./process.ts";

const LOCAL_PATH = /^(?:\/|[A-Za-z]:[\\/])/u;
const CONTROL = /\p{Cc}/u;
// run decodes UTF-8. Refuse replacement characters rather than equating
// different undecodable bytes (also conservatively refusing literal U+FFFD).
const REPLACEMENT = "\uFFFD";
const GIT_ENV: ReadonlyMap<string, string> = new Map([
  ["GIT_TERMINAL_PROMPT", "0"],
  ["GIT_CONFIG_NOSYSTEM", "1"],
  ["GIT_CONFIG_GLOBAL", "/dev/null"],
  ["ISSUE_PIPELINE_OPS", "1"],
]);

function assertGitRemote(cfg: Config, remote: string): void {
  if (
    !LOCAL_PATH.test(remote) &&
    remote !== `https://github.com/${cfg.repo}.git`
  ) {
    throw new OpsError(
      "credentialed git requires the configured GitHub repository HTTPS remote",
    );
  }
}

function refuseDestination(): never {
  throw new OpsError(
    "origin requires one unchanged fetch and push destination",
  );
}

// NUL terminates config records; whitespace remains URL data, never framing.
function configuredUrls(wt: string, key: string): string[] {
  const { code, stdout } = run("git", ["config", "--null", "--get-all", key], {
    cwd: wt,
    env: GIT_ENV,
    allowFail: true,
  });
  if (code === 1 && stdout === "") {
    return [];
  }
  if (code !== 0 || !stdout.endsWith("\0")) {
    return refuseDestination();
  }
  const values = stdout.slice(0, -1).split("\0");
  if (
    values.some(
      (value) =>
        value === "" ||
        value.trim() !== value ||
        CONTROL.test(value) ||
        value.includes(REPLACEMENT),
    )
  ) {
    return refuseDestination();
  }
  return values;
}

// Reject alternate/multiple/rewritten destinations without repairing config.
function assertGitPushDestination(cfg: Config, wt: string): void {
  const origins = configuredUrls(wt, "remote.origin.url");
  const pushes = configuredUrls(wt, "remote.origin.pushurl");
  const [raw] = origins;
  if (
    origins.length !== 1 ||
    raw === undefined ||
    pushes.length > 1 ||
    pushes.some((url) => url !== raw)
  ) {
    refuseDestination();
  }
  assertGitRemote(cfg, raw);
  for (const args of [
    ["remote", "get-url", "--all", "origin"],
    ["remote", "get-url", "--push", "--all", "origin"],
  ]) {
    // These commands have LF framing, so compare the entire single record.
    // The validated raw value contains no controls, including LF or CR.
    const { stdout } = run("git", args, { cwd: wt, env: GIT_ENV });
    if (stdout.includes(REPLACEMENT) || stdout !== `${raw}\n`) {
      refuseDestination();
    }
  }
}

export { assertGitPushDestination, assertGitRemote, GIT_ENV, LOCAL_PATH };
