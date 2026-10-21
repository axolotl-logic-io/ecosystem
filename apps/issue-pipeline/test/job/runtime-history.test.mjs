// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { FIXTURE_WINDOWS } from "../runtime-fixtures.mjs";
import { launch, privateRuntime } from "./runtime-policy-test-kit.mjs";

const { runSession } = await import("../../src/job/launch.ts");
const { runtimeBoundary, RUNTIME_SCHEMA } = await import(
  "../../src/job/runtime-policy.ts"
);
const { testConfig } = await import("../config-test-kit.mjs");
const START = z.object({ agentDir: z.string(), settings: z.unknown() });
const COMPACTION = {
  compaction: {
    enabled: true,
    reserveTokens: 97_000,
    keepRecentTokens: 30_000,
  },
};

test("resumed and new launch paths keep old history and independently generate policy", async () => {
  const kit = privateRuntime();
  const original = '{"type":"session","id":"preserved-original"}\n';
  const oldFile = kit.hooks.sessionFile("resumed");
  fs.writeFileSync(oldFile, original);
  const resumed = await runSession(launch({ key: "resumed" }), kit.hooks);
  const fresh = await runSession(launch({ key: "fresh" }), kit.hooks);
  assert.equal(resumed.ok, true);
  assert.equal(fresh.ok, true);
  const archives = fs
    .readdirSync(kit.root)
    .filter((name) => name.startsWith("resumed.") && name.endsWith(".jsonl"));
  assert.equal(archives.length, 1);
  const [archive] = archives;
  assert.ok(archive);
  assert.equal(fs.readFileSync(path.join(kit.root, archive), "utf8"), original);
  const starts = kit
    .calls()
    .map((call) => START.safeParse(call))
    .filter((start) => start.success);
  const [first, second] = starts;
  assert.ok(first?.success && second?.success);
  assert.notEqual(first.data.agentDir, second.data.agentDir);
  assert.deepEqual(first.data.settings, COMPACTION);
  assert.deepEqual(second.data.settings, COMPACTION);
});

test("repo config defaults and effective diagnostics name the complete nonsecret policy", () => {
  const { cfg } = testConfig({});
  assert.deepEqual(cfg.runtime, RUNTIME_SCHEMA.parse(undefined));
  const explicit = RUNTIME_SCHEMA.parse({
    modelContextWindows: FIXTURE_WINDOWS,
  });
  const boundary = runtimeBoundary(explicit, cfg.models);
  assert.equal(boundary.nativeVersion, "1.2.0");
  assert.equal(boundary.providerVersion, "0.4.3");
  assert.deepEqual(boundary.credentialEnv, ["PIPELINE_MODEL_KEY"]);
  assert.equal(boundary.policies.length, Object.keys(cfg.models).length);
  assert.deepEqual(
    boundary.policies.map(({ role }) => role),
    ["author", "implementor", "reviewer"],
  );
  assert.deepEqual(
    new Set(boundary.policies.map(({ reserveTokens }) => reserveTokens)),
    new Set([COMPACTION.compaction.reserveTokens]),
  );
});
