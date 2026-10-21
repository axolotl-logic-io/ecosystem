// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { pinnedOf } from "../prompt-test-kit.mjs";
import {
  json,
  MODEL,
  PROFILE,
  privateRuntime,
} from "./runtime-policy-test-kit.mjs";

/** @import { SessionLaunch } from "../../src/job/launch.ts" */
/** @import { RpcAnswer } from "../../src/job/rpc.ts" */
const { HOME } = await import("../../src/pipeline-root.ts");
const { runSession } = await import("../../src/job/launch.ts");
const { RUNTIME_SCHEMA } = await import("../../src/job/runtime-policy.ts");
const ERROR_RUNTIME = /runtime:/u;

/** @returns {SessionLaunch} */
function launch() {
  return {
    key: "runtime-startup",
    role: "author",
    agent: "issue-pipeline-author",
    model: "openai/gpt-6.1-sol",
    task: "Offline fixture task",
    outputSchema: { type: "object" },
    timeoutMs: 3000,
    commits: false,
    phase: null,
    prompt: pinnedOf("author.md"),
  };
}

test("startup hashes actual generated settings again before prompt", async () => {
  const kit = privateRuntime();
  Object.assign(kit.env, Object.fromEntries([["FAKE_CHANGE_SETTINGS", "yes"]]));
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", ERROR_RUNTIME);
  assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
});

test("startup hashes provider profile again before prompt", async () => {
  const kit = privateRuntime();
  Object.assign(kit.env, Object.fromEntries([["FAKE_CHANGE_PROFILE", "yes"]]));
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", ERROR_RUNTIME);
  assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
});

test("steer cannot start a model before native policy verification", async () => {
  const kit = privateRuntime();
  /** @type {Promise<RpcAnswer>[]} */
  const replies = [];
  kit.hooks.started = (_start, live) => {
    if (live.kind === "session") {
      replies.push(live.session.send({ type: "steer", message: "too early" }));
    }
  };
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, true);
  assert.deepEqual(await Promise.all(replies), [
    { success: false, error: "runtime policy not verified" },
  ]);
  assert.deepEqual(kit.calls().slice(1), [
    { command: "get_state" },
    { command: "prompt" },
  ]);
});

test("abort is acknowledged while native policy verification is pending", async () => {
  const kit = privateRuntime();
  /** @type {Promise<RpcAnswer>[]} */
  const replies = [];
  kit.hooks.started = (_start, live) => {
    if (live.kind === "session") {
      replies.push(live.session.send({ type: "abort" }));
    }
  };
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, true);
  assert.deepEqual(await Promise.all(replies), [
    { success: true, error: null },
  ]);
  assert.deepEqual(kit.calls().slice(1), [
    { command: "abort" },
    { command: "get_state" },
    { command: "prompt" },
  ]);
});

for (const home of [HOME, "relative-home"]) {
  test(`refuses non-isolated HOME ${home === HOME}`, async () => {
    const kit = privateRuntime();
    kit.runtime.home = home;
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls(), []);
  });
}

test("unprovisioned defaults cannot borrow a personal provider", async () => {
  const kit = privateRuntime();
  kit.hooks.runtime = RUNTIME_SCHEMA.parse(undefined);
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", ERROR_RUNTIME);
  assert.deepEqual(kit.calls(), []);
});

for (const change of [
  { overrides: { "gpt-6.1-sol": { contextWindow: 272_000 } } },
  {
    customProviders: {
      custom: {
        api: "openai-responses",
        models: [{ id: "custom", contextWindow: 272_000 }],
      },
    },
  },
]) {
  test("provider context-window overrides cannot fake native metadata", async () => {
    const kit = privateRuntime();
    json(path.join(kit.providerDir, "config.json"), {
      ...PROFILE,
      proxy: { endpoint: MODEL.baseUrl, apiKey: "$PIPELINE_MODEL_KEY" },
      ...change,
    });
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls(), []);
  });
}

for (const mode of ["missing", "ack", "uncorrelated"]) {
  test(`refuses ${mode} native verification despite a zero process exit`, async () => {
    const kit = privateRuntime();
    Object.assign(kit.env, Object.fromEntries([["FAKE_PROBE", mode]]));
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
    assert.ok(
      !JSON.stringify([raw, kit.records]).includes(
        "private-native-header-sentinel",
      ),
    );
  });
}

test("startup rechecks the discovery cache before prompt", async () => {
  const kit = privateRuntime();
  Object.assign(kit.env, Object.fromEntries([["FAKE_CHANGE_CACHE", "yes"]]));
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", ERROR_RUNTIME);
  assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
});
