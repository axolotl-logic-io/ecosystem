// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { FAKE_PI } from "./fake-rpc-pi.mjs";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import {
  FIXTURE_MODELS,
  fixtureState,
  versionProbe,
} from "./runtime-fixtures.mjs";

const UNSUPPORTED = /unsupported offline/u;

test("catalogue supplies only reviewed fixture models, never arbitrary matching state", () => {
  for (const model of Object.values(FIXTURE_MODELS)) {
    assert.deepEqual(fixtureState(model), {
      autoCompactionEnabled: true,
      model: {
        provider: "openai",
        id: "gpt-6.1-sol",
        contextWindow: 272_000,
        baseUrl: "https://proxy.invalid/v1",
        api: "openai-responses",
      },
    });
  }
  for (const model of [
    "flow/author-model",
    "openai/unknown",
    "openai/gpt-6.1-sol:unknown",
  ]) {
    assert.throws(() => fixtureState(model), UNSUPPORTED);
  }
  assert.equal(versionProbe(["--mode", "rpc"]), false);
  assert.throws(
    () => versionProbe(["--version", "--model", "unknown"]),
    UNSUPPORTED,
  );
});

test("version probes bypass session/usage setup; unsupported RPC cannot fake native verification", () => {
  const root = fs.mkdtempSync(path.join(isolatedRoot, "fake-protocol-"));
  const pi = path.join(root, "pi.mjs");
  fs.writeFileSync(pi, FAKE_PI);
  const env = {
    ...process.env,
    ...Object.fromEntries([["FAKE_PI_ROOT", root]]),
  };
  const version = spawnSync(process.execPath, [pi, "--version", "--offline"], {
    env,
    encoding: "utf8",
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, "1.2.0\n");
  assert.equal(fs.existsSync(path.join(root, "pi.log")), false);
  assert.equal(fs.existsSync(path.join(root, "prompts.count")), false);
  fs.writeFileSync(path.join(root, "pi-script.json"), "{}");
  const rpc = spawnSync(
    process.execPath,
    [pi, "--session", path.join(root, "session.jsonl")],
    {
      cwd: root,
      env,
      encoding: "utf8",
      input: `${JSON.stringify({ type: "unsupported", id: "test" })}\n`,
    },
  );
  assert.equal(rpc.status, 0, rpc.stderr);
  assert.deepEqual(JSON.parse(rpc.stdout), {
    type: "response",
    id: "test",
    command: "unsupported",
    success: false,
    error: "unsupported offline RPC request",
  });
});
