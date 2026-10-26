// The model child's explicit CLIProxy provisioning and generated native Pi
// settings. This changes neither the parent job's HOME nor its credentials.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { expand, HOME, ROOT } from "../pipeline-root.ts";
import type { NativePolicy, RuntimeConfig } from "./runtime-policy.ts";
import {
  NATIVE_VERSION,
  nativeSettings,
  PROVIDER_VERSION,
  policyOf,
  RUNTIME_SCHEMA,
} from "./runtime-policy.ts";
import { profileEndpoint } from "./runtime-provider.ts";
import { probeVersion } from "./runtime-version.ts";

// The native providers' fallback API keys. A model child gets one only when
// the runtime names it as the proxy's credential.
const NATIVE_FALLBACK_KEYS: ReadonlySet<string> = new Set([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
]);
const CHANGED_PROFILE =
  "runtime: generated settings or provisioned provider profile changed before the first prompt";
const PROVIDER_PACKAGE = z.object({
  name: z.literal("pi-cliproxyapi"),
  version: z.literal(PROVIDER_VERSION),
});

interface ProfileInput {
  model: string;
  cwd: string;
  session: string;
  runtime: RuntimeConfig | undefined;
  env: Readonly<Record<string, string>>;
}

interface PreparedRuntime {
  env: Readonly<Record<string, string>>;
  extension: string;
  endpoint: string;
  policy: NativePolicy;
  provenance: Readonly<Record<string, string>>;
  verify: () => string | null;
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function provisionedProfile(
  runtime: RuntimeConfig,
  policy: NativePolicy,
): {
  home: string;
  extension: string;
  endpoint: string;
  configText: string;
  cacheText: string;
  files: ReadonlyMap<string, string>;
} {
  const home = expand(runtime.home ?? path.join(ROOT, "runtime", "home"));
  if (!path.isAbsolute(home)) {
    throw new Error(
      "runtime: runtime.home must be absolute or null for the pipeline-root default",
    );
  }
  if (fs.realpathSync(home) === fs.realpathSync(HOME)) {
    throw new Error("runtime: runtime.home must be separate from the job HOME");
  }
  if (
    runtime.providerExtension === null ||
    !path.isAbsolute(expand(runtime.providerExtension))
  ) {
    throw new Error(
      "runtime: set an absolute trusted runtime.providerExtension path",
    );
  }
  const extension = fs.realpathSync(expand(runtime.providerExtension));
  const manifest: unknown = JSON.parse(
    fs.readFileSync(path.join(path.dirname(extension), "package.json"), "utf8"),
  );
  if (!PROVIDER_PACKAGE.safeParse(manifest).success) {
    throw new Error(
      "runtime: the trusted provider must be pi-cliproxyapi 0.4.3",
    );
  }
  const providerDir = path.join(home, ".pi", "agent", "pi-cliproxyapi");
  const configPath = path.join(providerDir, "config.json");
  const cachePath = path.join(providerDir, "discovery-cache.json");
  const configText = fs.readFileSync(configPath, "utf8");
  const cacheText = fs.readFileSync(cachePath, "utf8");
  const config: unknown = JSON.parse(configText);
  const cache: unknown = JSON.parse(cacheText);
  const endpoint = profileEndpoint(
    config,
    cache,
    runtime.credentialEnv,
    policy,
  );
  return {
    home,
    extension,
    endpoint,
    configText,
    cacheText,
    files: new Map([
      [configPath, configText],
      [cachePath, cacheText],
    ]),
  };
}

function validateCredentials(
  names: readonly string[],
  env: Readonly<Record<string, string>>,
  managed: Readonly<Record<string, string>>,
): void {
  for (const name of names) {
    if (Object.hasOwn(managed, name)) {
      throw new Error(
        "runtime: model credentials must not name pipeline-managed environment variables",
      );
    }
    const { [name]: value } = env;
    if (value === undefined || value.trim() === "") {
      throw new Error(
        `runtime: missing declared credential environment variable ${name}`,
      );
    }
    if (value.trim().startsWith("!") || value.includes("$")) {
      throw new Error(
        "runtime: model credential must be an opaque literal without native command/template syntax",
      );
    }
  }
}

function generatedEnvironment(
  input: ProfileInput,
  runtime: RuntimeConfig,
  home: string,
  policy: NativePolicy,
): {
  env: Record<string, string>;
  settingsText: string;
  settingsPath: string;
} {
  const agentDir = fs.mkdtempSync(`${input.session}.agent-`);
  const managed = Object.fromEntries([
    ["HOME", home],
    ["PI_CODING_AGENT_DIR", agentDir],
    ["PI_CODING_AGENT_SESSION_DIR", path.dirname(input.session)],
    ["PI_OFFLINE", "1"],
    ["PI_SKIP_VERSION_CHECK", "1"],
    ["PI_TELEMETRY", "0"],
  ]);
  const toolchain: Record<string, string> = {};
  for (const [name, value] of Object.entries(runtime.toolchainEnv)) {
    if (value !== undefined) {
      toolchain[name] = value;
    }
  }
  validateCredentials(runtime.credentialEnv, input.env, {
    ...managed,
    ...toolchain,
  });
  const settingsText = JSON.stringify(nativeSettings(policy));
  const settingsPath = path.join(agentDir, "settings.json");
  fs.writeFileSync(settingsPath, settingsText, { mode: 0o600 });
  const env = Object.fromEntries([
    ...Object.entries(input.env).filter(
      ([name]) =>
        !NATIVE_FALLBACK_KEYS.has(name) || runtime.credentialEnv.includes(name),
    ),
    ...Object.entries(toolchain),
    ...Object.entries(managed),
  ]);
  return { env, settingsText, settingsPath };
}

function verifiedRuntime(input: ProfileInput): PreparedRuntime {
  const runtime = RUNTIME_SCHEMA.parse(input.runtime);
  const policy = policyOf(input.model, runtime);
  const profile = provisionedProfile(runtime, policy);
  const { env, settingsText, settingsPath } = generatedEnvironment(
    input,
    runtime,
    profile.home,
    policy,
  );
  const refusal = probeVersion(input.cwd, env, runtime.credentialEnv);
  if (refusal !== null) {
    throw new Error(refusal);
  }
  return {
    env,
    verify: (): ReturnType<typeof verifyFiles> =>
      verifyFiles(new Map([...profile.files, [settingsPath, settingsText]])),
    extension: profile.extension,
    endpoint: profile.endpoint,
    policy,
    provenance: {
      settingsSha256: hashOf(settingsText),
      providerConfigSha256: hashOf(profile.configText),
      providerCacheSha256: hashOf(profile.cacheText),
      nativeVersion: NATIVE_VERSION,
      providerVersion: PROVIDER_VERSION,
    },
  };
}

function verifyFiles(
  files: ReadonlyMap<string, string>,
): typeof CHANGED_PROFILE | null {
  try {
    for (const [file, expected] of files) {
      if (hashOf(fs.readFileSync(file, "utf8")) !== hashOf(expected)) {
        return CHANGED_PROFILE;
      }
    }
    return null;
  } catch {
    return CHANGED_PROFILE;
  }
}

// Failure messages never include parsed provider data, credentials or command
// output; the only native stderr is the version probe's redacted, bounded
// excerpt. Missing provisioning cannot fall back to HOME.
function runtimeProfile(
  input: ProfileInput,
): PreparedRuntime | { error: string } {
  try {
    return verifiedRuntime(input);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("runtime:")) {
      return { error: error.message };
    }
    return {
      error:
        "runtime: cannot read or prepare the isolated profile; provision runtime.home, providerExtension, config.json and discovery-cache.json",
    };
  }
}

export { runtimeProfile };
