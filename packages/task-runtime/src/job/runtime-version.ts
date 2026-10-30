// The native version probe and its refusal (#108). A failed probe names its
// exit and a bounded, sanitized stderr excerpt; raw stderr and the
// child_process Error (whose message may quote output) never escape.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { NATIVE_VERSION } from "./runtime-policy.ts";

const VERSION_TIMEOUT_MS = 10_000;
// The job keeps the last 500 characters of a session error (raw-results.ts),
// so the excerpt leaves room for the refusal and exit before it.
const STDERR_BYTES = 300;
const REDACTED = "[redacted]";
const WRONG_VERSION = `runtime: the native pi executable must report version ${NATIVE_VERSION}`;
const SPAWN_ERROR = z.object({ code: z.string() });
const UNSAFE_CONTROLS = /[\p{Cc}\p{Cf}]/gu;
const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/iu;

// Credentials are redacted before controls are stripped and again after, so
// one split by an escape sequence is caught too.
function redacted(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => safe.split(secret).join(REDACTED),
    text,
  );
}

function sanitized(text: string, secrets: readonly string[]): string {
  const stripped = stripVTControlCharacters(redacted(text, secrets));
  return redacted(stripped.replace(UNSAFE_CONTROLS, ""), secrets);
}

function excerpt(stderr: string, secrets: readonly string[]): string {
  const clean = sanitized(stderr, secrets).trim();
  if (clean === "") {
    return "stderr was empty";
  }
  let bounded = "";
  let bytes = 0;
  for (const character of clean) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > STDERR_BYTES) {
      return `stderr (truncated to ${STDERR_BYTES} bytes): ${bounded}`;
    }
    bounded += character;
  }
  return `stderr: ${bounded}`;
}

function exitOf(result: SpawnSyncReturns<string>): string {
  if (result.status !== null) {
    return `exit status ${result.status}`;
  }
  const outcome = ["no normal exit status"];
  const code = SPAWN_ERROR.safeParse(result.error).data?.code;
  if (code === "ETIMEDOUT") {
    outcome.push(`timed out after ${VERSION_TIMEOUT_MS} ms`);
  } else if (code !== undefined) {
    outcome.push(`spawn error ${code}`);
  }
  if (result.signal !== null) {
    outcome.push(`signal ${result.signal}`);
  }
  return outcome.join(", ");
}

// Null when pi reports NATIVE_VERSION, else the refusal. Values of the
// declared credentials, and of any variable named like one, are redacted.
function probeVersion(
  cwd: string,
  env: Readonly<Record<string, string>>,
  credentialEnv: readonly string[],
): string | null {
  const result = spawnSync("pi", ["--version", "--offline"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    stdio: "pipe",
  });
  if (result.status === 0) {
    if (result.stdout.trim() === NATIVE_VERSION) {
      return null;
    }
    return WRONG_VERSION;
  }
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== "" &&
        (credentialEnv.includes(name) || CREDENTIAL_NAME.test(name)),
    )
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  return `${WRONG_VERSION}; the probe failed with ${exitOf(result)}; ${excerpt(result.stderr ?? "", secrets)}`;
}

export { probeVersion };
