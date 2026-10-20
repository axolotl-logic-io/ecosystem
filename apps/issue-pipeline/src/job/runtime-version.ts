// Native probe failures have one reportable representation; neither raw stderr
// nor a child_process Error (which may carry output) escapes this module.
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import { NATIVE_VERSION } from "./runtime-policy.ts";

const STDERR_BYTES = 2048;
const VERSION_TIMEOUT_MS = 10_000;
const SPAWN_ERROR = z.object({ code: z.string().optional() });
const UNSAFE_CONTROLS = /[\p{Cc}\p{Cf}]/gu;
const CREDENTIAL_NAME = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH/iu;

function sanitized(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    result = result.split(secret).join("[redacted]");
  }
  result = stripVTControlCharacters(result).replace(UNSAFE_CONTROLS, "");
  // Remove rather than replace controls so an interrupted credential is
  // reconstructed and redacted too, not reported as space-separated fragments.
  for (const secret of secrets) {
    const clean = stripVTControlCharacters(secret).replace(UNSAFE_CONTROLS, "");
    if (clean !== "") {
      result = result.split(clean).join("[redacted]");
    }
  }
  return result;
}

function excerpt(text: string, secrets: readonly string[]): string {
  const clean = sanitized(text, secrets);
  let bytes = 0;
  let bounded = "";
  for (const character of clean) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > STDERR_BYTES) {
      return `stderr excerpt (truncated): ${bounded}`;
    }
    bounded += character;
    bytes += size;
  }
  if (bounded === "") {
    return "stderr was empty";
  }
  return `stderr excerpt: ${bounded}`;
}

function versionRefusal(
  result: SpawnSyncReturns<string>,
  env: Readonly<Record<string, string>>,
  credentialNames: readonly string[],
): string | null {
  if (
    result.error === undefined &&
    result.signal === null &&
    result.status === 0 &&
    result.stdout.trim() === NATIVE_VERSION
  ) {
    return null;
  }
  const secrets = Object.entries(env)
    .filter(
      ([name, value]) =>
        value !== "" &&
        (credentialNames.includes(name) || CREDENTIAL_NAME.test(name)),
    )
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
  let outcome = `exit status ${result.status}`;
  if (result.status === null) {
    outcome = "no normal exit status was available";
  }
  if (result.error !== undefined) {
    // Node's error message/path/stack may contain output or secret paths. Only
    // the fixed system code is useful here, not the attached Error object.
    const code = SPAWN_ERROR.safeParse(result.error).data?.code;
    if (code === "ETIMEDOUT") {
      outcome += "; probe timed out (ETIMEDOUT)";
    } else {
      outcome += `; spawn/probe error ${sanitized(code ?? "unknown", secrets)}`;
    }
  }
  if (result.signal !== null) {
    outcome += `; termination signal ${sanitized(result.signal, secrets)}`;
  }
  return `runtime: the native pi executable must report version ${NATIVE_VERSION}; ${outcome}; ${excerpt(result.stderr ?? "", secrets)}`;
}

function probeVersion(
  cwd: string,
  env: Readonly<Record<string, string>>,
  knownEnv: Readonly<Record<string, string>>,
  credentialNames: readonly string[],
): string | null {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync("pi", ["--version", "--offline"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      // spawnSync waits for exit after its timeout signal. SIGTERM can be
      // ignored by a broken shim; use an unignorable signal to finish refusal.
      killSignal: "SIGKILL",
      stdio: "pipe",
    });
  } catch (error: unknown) {
    // Invalid spawn inputs can throw instead of returning a process result.
    // Treat them like returned spawn failures; their message/stack may quote
    // environment values, so only versionRefusal's parsed code is reportable.
    let failure = new Error("unknown probe failure");
    if (error instanceof Error) {
      failure = error;
    }
    result = {
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: failure,
    };
  }
  return versionRefusal(result, knownEnv, credentialNames);
}

export { probeVersion, versionRefusal };
