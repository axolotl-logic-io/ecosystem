// The pipeline's native compaction contract and the small part of Pi's RPC
// state needed to verify a launch. No model metadata is invented or rewritten.
import { z } from "zod";

const TARGET_TOKENS = 175_000;
const KEEP_RECENT_TOKENS = 30_000;
const NATIVE_VERSION = "1.2.0";
const PROVIDER_VERSION = "0.4.3";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MODEL_REFERENCE =
  /^(?<provider>[^/:]+)\/(?<id>.+?)(?::(?:off|minimal|low|medium|high|xhigh|max))?$/u;
const TRAILING_SLASHES = /\/+$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_INTEGER = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const RUNTIME_SCHEMA = z
  .object({
    home: z.string().min(1).nullable().default(null),
    providerExtension: z.string().min(1).nullable().default(null),
    credentialEnv: z
      .array(z.string().regex(ENV_NAME))
      .min(1)
      .default(["PIPELINE_MODEL_KEY"]),
    compaction: z
      .object({
        targetTokens: z.literal(TARGET_TOKENS).default(TARGET_TOKENS),
        keepRecentTokens: z
          .literal(KEEP_RECENT_TOKENS)
          .default(KEEP_RECENT_TOKENS),
      })
      .default({
        targetTokens: TARGET_TOKENS,
        keepRecentTokens: KEEP_RECENT_TOKENS,
      }),
    modelContextWindows: z
      .record(z.string(), SAFE_INTEGER.positive())
      .default({}),
  })
  .default({
    home: null,
    providerExtension: null,
    credentialEnv: ["PIPELINE_MODEL_KEY"],
    compaction: {
      targetTokens: TARGET_TOKENS,
      keepRecentTokens: KEEP_RECENT_TOKENS,
    },
    modelContextWindows: {},
  });

type RuntimeConfig = z.infer<typeof RUNTIME_SCHEMA>;

const NATIVE_POLICY = z.object({
  provider: z.string(),
  id: z.string(),
  contextWindow: SAFE_INTEGER.positive(),
  targetTokens: SAFE_INTEGER.positive(),
  enabled: z.literal(true),
  reserveTokens: SAFE_INTEGER,
  keepRecentTokens: SAFE_INTEGER,
});
const SHA256 = z.string().regex(SHA256_HEX);
// An allowlist, not raw native state or provider configuration. Used both
// for the verified diagnostic and the launch's evidence in job.json.
const RUNTIME_POLICY = NATIVE_POLICY.extend({
  type: z.literal("runtime_policy"),
  endpoint: z.string(),
  settingsSha256: SHA256,
  providerConfigSha256: SHA256,
  providerCacheSha256: SHA256,
  nativeVersion: z.string(),
  providerVersion: z.string(),
});

type NativePolicy = z.infer<typeof NATIVE_POLICY>;

const INVALID_STATE =
  "runtime: native state is missing valid model metadata or enabled compaction";
const MISMATCHED_STATE =
  "runtime: native provider/model/window/endpoint does not match the explicit runtime profile";

type StateRefusal = typeof INVALID_STATE | typeof MISMATCHED_STATE | null;

interface RuntimeBoundary {
  nativeVersion: typeof NATIVE_VERSION;
  providerVersion: typeof PROVIDER_VERSION;
  home: string;
  providerExtension: string | null;
  credentialEnv: string[];
  projectConfiguration: "disabled";
  resources: "explicit extensions only";
  mode: "rpc";
  providerCacheOnlyFlag: "--print";
  providerScope: "OpenAI builtin via distinct proxy endpoint only";
  ambientAuth: "OPENAI_API_KEY only when explicitly declared";
  nativeOffline: true;
  policies: (NativePolicy & { role: string })[];
}

const NATIVE_STATE = z.object({
  model: z.object({
    provider: z.string(),
    id: z.string(),
    contextWindow: SAFE_INTEGER.positive(),
    baseUrl: z.string(),
    api: z.enum(["openai-responses", "openai-completions"]),
  }),
  autoCompactionEnabled: z.literal(true),
});

function policyOf(model: string, runtime: RuntimeConfig): NativePolicy {
  const { provider, id } = MODEL_REFERENCE.exec(model)?.groups ?? {};
  if (provider === undefined || id === undefined) {
    throw new Error("runtime: models must name an exact provider/model ID");
  }
  const key = `${provider}/${id}`;
  const { [key]: contextWindow } = runtime.modelContextWindows;
  if (contextWindow === undefined) {
    throw new Error(`runtime: missing expected context window for ${key}`);
  }
  const { targetTokens, keepRecentTokens } = runtime.compaction;
  if (contextWindow <= targetTokens || keepRecentTokens >= targetTokens) {
    throw new Error(
      `runtime: ${key} cannot support the native compaction target and recent context`,
    );
  }
  return {
    provider,
    id,
    contextWindow,
    targetTokens,
    enabled: true,
    reserveTokens: contextWindow - targetTokens,
    keepRecentTokens,
  };
}

// Pi reads this one generated agent-directory file with project trust off.
// There are no inherited model overrides, packages, MCP servers or resources.
function nativeSettings(policy: NativePolicy): {
  compaction: {
    enabled: true;
    reserveTokens: number;
    keepRecentTokens: number;
  };
} {
  return {
    compaction: {
      enabled: true,
      reserveTokens: policy.reserveTokens,
      keepRecentTokens: policy.keepRecentTokens,
    },
  };
}

function stateRefusal(
  data: unknown,
  policy: NativePolicy,
  endpoint: string,
): StateRefusal {
  const parsed = NATIVE_STATE.safeParse(data);
  if (!parsed.success) {
    return INVALID_STATE;
  }
  const { model } = parsed.data;
  const expectedEndpoint = endpoint.replace(TRAILING_SLASHES, "");
  if (
    model.provider !== policy.provider ||
    model.id !== policy.id ||
    model.contextWindow !== policy.contextWindow ||
    model.baseUrl !== expectedEndpoint
  ) {
    return MISMATCHED_STATE;
  }
  return null;
}

function runtimeBoundary(
  runtime: RuntimeConfig,
  models: Readonly<Record<string, string>>,
): RuntimeBoundary {
  return {
    nativeVersion: NATIVE_VERSION,
    providerVersion: PROVIDER_VERSION,
    home: runtime.home ?? "$ISSUE_PIPELINE_ROOT/runtime/home",
    providerExtension: runtime.providerExtension,
    credentialEnv: runtime.credentialEnv,
    projectConfiguration: "disabled",
    resources: "explicit extensions only",
    mode: "rpc",
    providerCacheOnlyFlag: "--print",
    providerScope: "OpenAI builtin via distinct proxy endpoint only",
    ambientAuth: "OPENAI_API_KEY only when explicitly declared",
    nativeOffline: true,
    policies: Object.entries(models).map(([role, model]) => ({
      role,
      ...policyOf(model, runtime),
    })),
  };
}

export type { NativePolicy, RuntimeConfig };
export {
  NATIVE_VERSION,
  nativeSettings,
  PROVIDER_VERSION,
  policyOf,
  RUNTIME_POLICY,
  RUNTIME_SCHEMA,
  runtimeBoundary,
  stateRefusal,
};
