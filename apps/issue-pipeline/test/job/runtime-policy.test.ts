import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import type { SessionLaunch } from "../../src/job/launch.ts";
import type { SessionRaw } from "../../src/job/raw-results.ts";
import { FIXTURE_WINDOWS } from "../runtime-fixtures.ts";
import {
  json,
  launch,
  MODEL,
  PROFILE,
  privateRuntime,
} from "./runtime-policy-test-kit.ts";

const { AGENT_DIR }: typeof import("../../src/pipeline-root.ts") = await import(
  "../../src/pipeline-root.ts"
);
const { runSession }: typeof import("../../src/job/launch.ts") = await import(
  "../../src/job/launch.ts"
);
const { STAGE_AGENTS }: typeof import("../../src/job/roles.ts") = await import(
  "../../src/job/roles.ts"
);
const TARGET = 175_000;
const HASH_LENGTH = 64;
const DIAGNOSTIC = z.object({
  targetTokens: z.literal(TARGET),
  settingsSha256: z.string().length(HASH_LENGTH),
});
const DEFAULT_RESERVE = 97_000;
const LARGER_RESERVE = 125_000;
const ERROR_RUNTIME = /runtime:/u;
const MODEL_ID = "openai/gpt-6.1-sol";
const START_SETTINGS = z.object({
  settings: z.object({
    compaction: z.object({ reserveTokens: z.number() }),
  }),
});
function reserveOf(start: unknown): number {
  return START_SETTINGS.parse(start).settings.compaction.reserveTokens;
}
const CREDENTIALS =
  /private-credential-sentinel|private-native-header-sentinel|forbidden-job-token|forbidden-role-token/u;

// Every actual stage/phase reaches the same native policy preparation path.
for (const [stage, entry] of Object.entries(STAGE_AGENTS)) {
  for (const session of entry.sessions) {
    test(`native policy precedes ${stage} ${session.phase ?? "unphased"} with commits ${session.commits}`, async () => {
      const kit = privateRuntime();
      const raw = await runSession(
        launch({ role: entry.role, agent: entry.agent, ...session }),
        kit.hooks,
      );
      assert.equal(raw.ok, true, raw.error ?? "");
      const calls = kit.calls();
      const [start, ...commands] = calls;
      assert.ok(start);
      const { settings, home, agentDir, env, scope } = start;
      assert.deepEqual(settings, {
        compaction: {
          enabled: true,
          reserveTokens: 97_000,
          keepRecentTokens: 30_000,
        },
      });
      assert.equal(home, kit.runtime.home);
      assert.notEqual(agentDir, AGENT_DIR);
      assert.deepEqual(commands, [
        { command: "get_state" },
        { command: "prompt" },
      ]);
      assert.ok(Array.isArray(env));
      assert.ok(!env.includes("GH_TOKEN"));
      assert.ok(!env.includes("MERGE_TOKEN"));
      assert.equal(scope !== null, session.commits);
      assert.doesNotMatch(JSON.stringify([kit.records, raw]), CREDENTIALS);
      const policy = kit.records.find(
        (record) =>
          typeof record === "object" &&
          record !== null &&
          "type" in record &&
          record.type === "runtime_policy",
      );
      DIAGNOSTIC.parse(policy);

      // The fake's compaction events cannot stop/replace the session: one
      // process, one prompt, same structured-output lifecycle.
      assert.equal(
        kit.records.filter(
          (record) =>
            typeof record === "object" &&
            record !== null &&
            "type" in record &&
            record.type === "auto_compaction_end",
        ).length,
        1,
      );
    });
  }
}

for (const [name, state] of [
  ["missing native data", {}],
  ["disabled compaction", { model: MODEL, autoCompactionEnabled: false }],
  [
    "unsupported native API",
    {
      model: { ...MODEL, api: "anthropic-messages" },
      autoCompactionEnabled: true,
    },
  ],
  [
    "changed window",
    {
      model: { ...MODEL, contextWindow: 300_000 },
      autoCompactionEnabled: true,
    },
  ],
  [
    "different provider",
    { model: { ...MODEL, provider: "other" }, autoCompactionEnabled: true },
  ],
  [
    "different model",
    { model: { ...MODEL, id: "other" }, autoCompactionEnabled: true },
  ],
  [
    "host provider fallback",
    {
      model: { ...MODEL, baseUrl: "https://api.openai.com/v1" },
      autoCompactionEnabled: true,
    },
  ],
]) {
  test(`${name} refuses before prompt`, async () => {
    const kit = privateRuntime();
    kit.setState(state);
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
    assert.doesNotMatch(JSON.stringify([raw, kit.records]), CREDENTIALS);
  });
}

for (const file of ["config.json", "discovery-cache.json"]) {
  test(`missing ${file} fails before native launch`, async () => {
    const kit = privateRuntime();
    fs.unlinkSync(path.join(kit.providerDir, file));
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls(), []);
  });
}

test("invalid cache and literal credentials cannot trigger discovery", async () => {
  const kit = privateRuntime();
  json(path.join(kit.providerDir, "discovery-cache.json"), {});
  let raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.deepEqual(kit.calls(), []);
  const other = privateRuntime();
  json(path.join(other.providerDir, "config.json"), {
    ...PROFILE,
    proxy: { endpoint: MODEL.baseUrl, apiKey: "private-credential-sentinel" },
  });
  raw = await runSession(launch(), other.hooks);
  assert.equal(raw.ok, false);
  assert.doesNotMatch(JSON.stringify(raw), CREDENTIALS);
  assert.deepEqual(other.calls(), []);
});

test("absent declared credential refuses without printing its value", async () => {
  const kit = privateRuntime();
  Object.assign(kit.env, Object.fromEntries([["PIPELINE_MODEL_KEY", ""]]));
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.deepEqual(kit.calls(), []);
  assert.doesNotMatch(JSON.stringify(raw), CREDENTIALS);
});

test("version-sensitive native adapter refuses an unverified version", async () => {
  const kit = privateRuntime();
  kit.hooks.env = (): { [k: string]: string } =>
    Object.fromEntries([
      ["PATH", path.join(kit.root, "bin")],
      ["PRIVATE_RUNTIME_ROOT", kit.root],
      ["PIPELINE_MODEL_KEY", "test"],
      ["FAKE_NATIVE_VERSION", "9.0.0"],
    ]);
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.deepEqual(kit.calls(), []);
});

test("provider version is explicit, not an ambient package assumption", async () => {
  const kit = privateRuntime();
  json(path.join(kit.root, "provider", "package.json"), {
    name: "pi-cliproxyapi",
    version: "9.0.0",
  });
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.deepEqual(kit.calls(), []);
});

test("native window maps the fixed target to reserve, with impossible and missing windows refused", async () => {
  async function launchWith(
    windows: Record<string, number> | undefined,
    changes: Partial<SessionLaunch> = {},
  ): Promise<{ raw: SessionRaw; start: Record<string, unknown> | undefined }> {
    const kit = privateRuntime();
    kit.hooks.runtime = { ...kit.runtime, modelContextWindows: windows ?? {} };
    kit.setState({
      model: {
        ...MODEL,
        contextWindow: windows?.[MODEL_ID] ?? MODEL.contextWindow,
      },
      autoCompactionEnabled: true,
    });
    const raw = await runSession(launch(changes), kit.hooks);
    return { raw, start: kit.calls()[0] };
  }
  const thinking = await launchWith(FIXTURE_WINDOWS, {
    model: `${MODEL_ID}:high`,
  });
  assert.equal(thinking.raw.ok, true, thinking.raw.error ?? "");
  assert.equal(reserveOf(thinking.start), DEFAULT_RESERVE);
  const changed = await launchWith({ [MODEL_ID]: 300_000 });
  assert.equal(changed.raw.ok, true, changed.raw.error ?? "");
  assert.equal(reserveOf(changed.start), LARGER_RESERVE);
  const refusals: [Record<string, number> | undefined, string][] = [
    [undefined, MODEL_ID],
    [{ [MODEL_ID]: TARGET }, MODEL_ID],
    [FIXTURE_WINDOWS, "other/model"],
  ];
  const refused = await Promise.all(
    refusals.map(([windows, model]) => launchWith(windows, { model })),
  );
  for (const { raw, start } of refused) {
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.equal(start, undefined);
  }
});
