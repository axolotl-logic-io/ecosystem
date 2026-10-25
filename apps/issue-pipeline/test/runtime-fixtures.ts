// Explicit offline catalogue. Unknown models never acquire invented metadata.
// No source imports: callers establish HOME/root before loading the pipeline.
import fs from "node:fs";
import path from "node:path";

const FIXTURE_MODEL = {
  provider: "openai",
  id: "gpt-6.1-sol",
  contextWindow: 272_000,
  baseUrl: "https://proxy.invalid/v1",
  api: "openai-responses",
};
const FIXTURE_WINDOWS = { "openai/gpt-6.1-sol": 272_000 };
const FIXTURE_MODELS = {
  author: "openai/gpt-6.1-sol:low",
  implementor: "openai/gpt-6.1-sol:medium",
  reviewer: "openai/gpt-6.1-sol:high",
};
const CATALOGUE = new Set([
  "openai/gpt-6.1-sol",
  ...Object.values(FIXTURE_MODELS),
]);

function fixtureState(model: string): {
  model: typeof FIXTURE_MODEL;
  autoCompactionEnabled: true;
} {
  if (!CATALOGUE.has(model)) {
    throw new Error("unsupported offline fixture model");
  }
  return { model: FIXTURE_MODEL, autoCompactionEnabled: true };
}

function provisionFixture(root: string): {
  home: string;
  providerExtension: string;
  credentialEnv: string[];
  modelContextWindows: typeof FIXTURE_WINDOWS;
} {
  const home = path.join(root, "model-home");
  const profile = path.join(home, ".pi", "agent", "pi-cliproxyapi");
  const provider = path.join(root, "fixture-provider");
  for (const dir of [profile, provider]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(provider, "index.ts"),
    "throw new Error('fake pi must not load provider code');\n",
  );
  fs.writeFileSync(
    path.join(provider, "package.json"),
    JSON.stringify({
      name: "pi-cliproxyapi",
      version: "0.4.3",
    }),
  );
  fs.writeFileSync(
    path.join(profile, "config.json"),
    JSON.stringify({
      proxy: { endpoint: FIXTURE_MODEL.baseUrl, apiKey: "$PIPELINE_MODEL_KEY" },
      builtinProviders: {
        openai: { enabled: true, models: [FIXTURE_MODEL.id] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(profile, "discovery-cache.json"),
    JSON.stringify({
      savedAt: 1,
      discovery: {
        source: "well-known",
        upstreamVersion: null,
        customPool: [],
        serverDiscoveryExcludes: [],
        upstreamTotal: 1,
        builtinProviders: [
          {
            name: "openai",
            api: "openai-responses",
            models: [
              {
                id: FIXTURE_MODEL.id,
                name: "Offline fixture",
                reasoning: true,
                contextWindow: FIXTURE_MODEL.contextWindow,
                maxTokens: 32_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        ],
      },
    }),
  );
  return {
    home,
    providerExtension: path.join(provider, "index.ts"),
    credentialEnv: ["PIPELINE_MODEL_KEY"],
    modelContextWindows: FIXTURE_WINDOWS,
  };
}

function versionProbe(argv: readonly string[]): boolean {
  if (!argv.includes("--version")) {
    return false;
  }
  if (argv.join(" ") !== "--version --offline") {
    throw new Error("unsupported offline version request");
  }
  process.stdout.write("1.2.0\n");
  return true;
}

export {
  FIXTURE_MODELS,
  FIXTURE_WINDOWS,
  fixtureState,
  provisionFixture,
  versionProbe,
};
