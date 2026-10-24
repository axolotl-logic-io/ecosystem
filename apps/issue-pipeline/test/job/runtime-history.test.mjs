// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { launch, privateRuntime } from "./runtime-policy-test-kit.mjs";

const { runSession } = await import("../../src/job/launch.ts");
const { nativeSettings, policyOf } = await import(
  "../../src/job/runtime-policy.ts"
);
const START = z.object({ agentDir: z.string(), settings: z.unknown() });
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
  assert.deepEqual(
    first.data.settings,
    nativeSettings(policyOf(launch().model, kit.runtime)),
  );
  assert.deepEqual(second.data.settings, first.data.settings);
});
