// The narrowly supported CLIProxy 0.4.3 profile: explicit OpenAI registration
// from a reviewed cache, with no context-window synthesis or native fallback.
import { z } from "zod";
import type { NativePolicy } from "./runtime-policy.ts";

const CREDENTIAL_REFERENCE = /^\$(?<name>[A-Za-z_][A-Za-z0-9_]*)$/u;
const SAFE_INTEGER = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const SUPPORTED_API = z.enum(["openai-responses", "openai-completions"]);
const MODEL_OVERRIDE = z.strictObject({
  id: z.string().optional(),
  name: z.string().optional(),
  maxTokens: SAFE_INTEGER.positive().optional(),
  reasoning: z.boolean().optional(),
  cost: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    })
    .optional(),
});
const PROFILE_CONFIG = z.strictObject({
  proxy: z.strictObject({
    endpoint: z.url(),
    apiKey: z.string(),
    usageKey: z.literal("").optional(),
    providerPrefix: z.string().optional(),
  }),
  builtinProviders: z.strictObject({
    openai: z.strictObject({
      enabled: z.literal(true),
      models: z.array(z.string().min(1)).min(1),
      apiOverride: SUPPORTED_API.nullable().optional(),
    }),
  }),
  customProviders: z.record(z.string(), z.never()).optional(),
  overrides: z.record(z.string(), MODEL_OVERRIDE).optional(),
  discoveryExcludes: z.array(z.string()).optional(),
  refreshIntervalMinutes: z.literal(0).optional(),
  usageCacheTtlMs: SAFE_INTEGER.optional(),
});
const CACHE_MODEL = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  reasoning: z.boolean(),
  contextWindow: SAFE_INTEGER.positive(),
  maxTokens: SAFE_INTEGER.positive(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
});
const PROFILE_CACHE = z.object({
  savedAt: z.number(),
  discovery: z.object({
    source: z.enum(["well-known", "v1-models"]),
    upstreamVersion: z.string().nullable(),
    builtinProviders: z.array(
      z.object({
        name: z.string(),
        api: z.string(),
        models: z.array(CACHE_MODEL),
      }),
    ),
    customPool: z.array(
      CACHE_MODEL.extend({
        api: z.string(),
        suggestedProvider: z.string(),
        ownedBy: z.string(),
      }),
    ),
    serverDiscoveryExcludes: z.array(z.string()),
    upstreamTotal: SAFE_INTEGER,
  }),
});

// The provider's separate credentials must be explicit environment references,
// never a personal keyring command or a literal copied into a portable profile.
function profileEndpoint(
  config: unknown,
  cache: unknown,
  credentialEnv: readonly string[],
  policy: NativePolicy,
): string {
  const parsed = PROFILE_CONFIG.safeParse(config);
  const catalogue = PROFILE_CACHE.safeParse(cache);
  if (!(parsed.success && catalogue.success) || policy.provider !== "openai") {
    throw new Error(
      "runtime: provision the supported OpenAI CLIProxy config and discovery cache (no custom providers or window overrides)",
    );
  }
  const { openai } = parsed.data.builtinProviders;
  const candidates = catalogue.data.discovery.builtinProviders.filter(
    (entry) => entry.name === "openai",
  );
  const [cached] = candidates;
  if (
    !openai.models.includes(policy.id) ||
    candidates.length !== 1 ||
    cached === undefined ||
    !SUPPORTED_API.safeParse(cached.api).success ||
    cached.models.filter((model) => model.id === policy.id).length !== 1
  ) {
    throw new Error(
      "runtime: selected OpenAI model must be enabled/whitelisted and present in the reviewed discovery cache",
    );
  }
  const { endpoint, apiKey } = parsed.data.proxy;
  const { name } = CREDENTIAL_REFERENCE.exec(apiKey)?.groups ?? {};
  if (name === undefined || !credentialEnv.includes(name)) {
    throw new Error(
      "runtime: CLIProxy apiKey must reference a declared credential environment variable",
    );
  }
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("runtime: CLIProxy endpoint must be a nonsecret HTTP URL");
  }
  if (url.hostname === "api.openai.com") {
    throw new Error(
      "runtime: proxy endpoint must differ from the native OpenAI endpoint; native fallback cannot prove provider registration",
    );
  }
  return endpoint;
}

export { profileEndpoint };
