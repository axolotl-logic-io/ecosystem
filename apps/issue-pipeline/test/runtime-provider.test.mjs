// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pinnedOf } from "./brain-test-kit.mjs";
import {
  CACHE,
  json,
  MODEL,
  PROFILE,
  privateRuntime,
} from "./runtime-policy-test-kit.mjs";

/** @import { SessionLaunch } from "../src/job/launch.ts" */
const { runSession } = await import("../src/job/launch.ts");
const ERROR_RUNTIME = /runtime:/u;

/** @returns {SessionLaunch} */
function launch() {
  return {
    key: "provider-input",
    role: "author",
    agent: "issue-pipeline-author",
    model: "openai/gpt-6.1-sol",
    task: "Offline fixture task",
    outputSchema: { type: "object" },
    timeoutMs: 3000,
    commits: false,
    phase: null,
    prompt: pinnedOf("Pipeline-Prompt-Author.md"),
  };
}

/** @type {[string, Record<string, unknown>][]} */
const CONFIG_FAILURES = [
  ["empty config", { builtinProviders: {} }],
  [
    "disabled provider",
    { builtinProviders: { openai: { enabled: false, models: [MODEL.id] } } },
  ],
  [
    "model not whitelisted",
    { builtinProviders: { openai: { enabled: true, models: ["other"] } } },
  ],
  [
    "unsupported API",
    {
      builtinProviders: {
        openai: {
          enabled: true,
          models: [MODEL.id],
          apiOverride: "unrecognized",
        },
      },
    },
  ],
  [
    "custom provider",
    {
      customProviders: {
        custom: { api: "openai-responses", models: [{ id: MODEL.id }] },
      },
    },
  ],
  [
    "native endpoint ambiguity",
    { proxy: { ...PROFILE.proxy, endpoint: "https://api.openai.com/v1" } },
  ],
];
for (const [name, change] of CONFIG_FAILURES) {
  test(`${name} refuses before native spawn or prompt`, async () => {
    const kit = privateRuntime();
    json(path.join(kit.providerDir, "config.json"), { ...PROFILE, ...change });
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls(), []);
    assert.equal(
      fs.existsSync(path.join(kit.root, "version-calls.txt")),
      false,
    );
  });
}

for (const [name, builtinProviders] of [
  ["empty catalogue", []],
  [
    "ambiguous duplicate provider",
    [...CACHE.discovery.builtinProviders, ...CACHE.discovery.builtinProviders],
  ],
  [
    "ambiguous duplicate model",
    CACHE.discovery.builtinProviders.map((provider) => ({
      ...provider,
      models: [...provider.models, ...provider.models],
    })),
  ],
  [
    "unsupported cached API",
    CACHE.discovery.builtinProviders.map((provider) => ({
      ...provider,
      api: "unknown",
    })),
  ],
  [
    "wrong provider",
    CACHE.discovery.builtinProviders.map((provider) => ({
      ...provider,
      name: "other",
    })),
  ],
  [
    "wrong model",
    CACHE.discovery.builtinProviders.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model, id: "other" })),
    })),
  ],
]) {
  test(`${name} refuses before native spawn or fallback`, async () => {
    const kit = privateRuntime();
    json(path.join(kit.providerDir, "discovery-cache.json"), {
      ...CACHE,
      discovery: { ...CACHE.discovery, builtinProviders },
    });
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls(), []);
    assert.equal(
      fs.existsSync(path.join(kit.root, "version-calls.txt")),
      false,
    );
  });
}

for (const credential of [
  "  !unsafe-command",
  "!not-a-command-to-run",
  "$NOT_A_REFERENCE_TO_RESOLVE",
]) {
  test("resolved proxy credentials cannot become native commands/templates", async () => {
    const kit = privateRuntime();
    Object.assign(
      kit.env,
      Object.fromEntries([["PIPELINE_MODEL_KEY", credential]]),
    );
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls(), []);
    assert.equal(
      fs.existsSync(path.join(kit.root, "version-calls.txt")),
      false,
    );
    assert.ok(!JSON.stringify(raw).includes(credential));
  });
}

test("native catalogue preference does not demand a fabricated cache window", async () => {
  const kit = privateRuntime();
  const builtinProviders = CACHE.discovery.builtinProviders.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({
      ...model,
      contextWindow: 300_000,
    })),
  }));
  json(path.join(kit.providerDir, "discovery-cache.json"), {
    ...CACHE,
    discovery: { ...CACHE.discovery, builtinProviders },
  });
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, true);
  assert.deepEqual(kit.calls().slice(1), [
    { command: "get_state" },
    { command: "prompt" },
  ]);
});

test("undeclared ambient native OpenAI auth is removed", async () => {
  const kit = privateRuntime();
  Object.assign(
    kit.env,
    Object.fromEntries([["OPENAI_API_KEY", "ambient-key-must-not-pass"]]),
  );
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, true);
  const [start] = kit.calls();
  assert.ok(start);
  const { env } = start;
  assert.ok(Array.isArray(env));
  assert.ok(!env.includes("OPENAI_API_KEY"));
  assert.ok(env.includes("PIPELINE_MODEL_KEY"));
});

test("a deliberately named native OpenAI variable can supply the explicit proxy credential", async () => {
  const kit = privateRuntime();
  kit.runtime.credentialEnv = ["OPENAI_API_KEY"];
  Object.assign(
    kit.env,
    Object.fromEntries([["OPENAI_API_KEY", "explicit-proxy-key"]]),
  );
  json(path.join(kit.providerDir, "config.json"), {
    ...PROFILE,
    proxy: { ...PROFILE.proxy, apiKey: "$OPENAI_API_KEY" },
  });
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, true);
  const [start] = kit.calls();
  assert.ok(start);
  const { env } = start;
  assert.ok(Array.isArray(env));
  assert.ok(env.includes("OPENAI_API_KEY"));
});
