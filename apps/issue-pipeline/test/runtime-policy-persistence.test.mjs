// @ts-check
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { messageEnd, toolEnd } from "./fake-rpc-pi.mjs";
import {
  expectedPolicy,
  launch,
  recordedRuntime,
  USAGE,
} from "./runtime-policy-persistence-test-kit.mjs";
import { CACHE, json, MODEL, PROFILE } from "./runtime-policy-test-kit.mjs";

const { runSession } = await import("../src/job/launch.ts");
const { STAGE_AGENTS } = await import("../src/job/roles.ts");
const { readStatus } = await import("../src/job/status.ts");
const ERROR_RUNTIME = /runtime:/u;
const PRIVATE_DATA =
  /private-credential-sentinel|private-native-header-sentinel|forbidden-job-token|forbidden-role-token|private-extra-field/u;

for (const [stage, entry] of Object.entries(STAGE_AGENTS)) {
  for (const session of entry.sessions) {
    test(`job.json retains the verified policy for ${stage} ${session.phase ?? "unphased"} with commits ${session.commits}`, async () => {
      const kit = recordedRuntime(stage);
      const expected = expectedPolicy(kit);
      const raw = await runSession(
        launch({ role: entry.role, agent: entry.agent, ...session }),
        kit.hooks,
      );
      assert.equal(raw.ok, true, raw.error ?? "");
      kit.status.settled("author-1", "ok");
      kit.status.finish({ kind: "finished", end: "next" });
      const written = JSON.parse(fs.readFileSync(kit.file, "utf8"));
      const reread = readStatus(kit.root);
      assert.ok(reread);
      assert.deepEqual(reread.launches, written.launches);
      assert.doesNotMatch(JSON.stringify(written), PRIVATE_DATA);
      const [saved] = reread.launches;
      assert.ok(saved);
      assert.deepEqual(saved.runtimePolicy, expected);
      assert.deepEqual(saved.usage, USAGE);
      assert.equal(saved.turns, 1);
      // The successful structured-output call follows the failed tool event
      // and resets the consecutive failure counter.
      assert.equal(saved.toolFailures, 0);
      assert.equal(saved.outcome, "ok");
      const prompt = kit.calls().find(({ command }) => command === "prompt");
      assert.ok(prompt);
      const { policyAtPrompt } = prompt;
      assert.deepEqual(policyAtPrompt, expected);
    });
  }
}

test("accepted policy survives session failure, later events and final job status", async () => {
  const kit = recordedRuntime("implement");
  Object.assign(kit.env, Object.fromEntries([["FAKE_SESSION_FAILURE", "yes"]]));
  const expected = expectedPolicy(kit);
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  kit.status.settled("author-1", "failed");
  kit.status.finish({
    kind: "failed",
    error: "session failed after verification",
  });
  const [saved] = readStatus(kit.root)?.launches ?? [];
  assert.ok(saved);
  assert.deepEqual(saved.runtimePolicy, expected);
  assert.deepEqual(saved.usage, USAGE);
  assert.equal(saved.toolFailures, 1);
  assert.equal(saved.outcome, "failed");
});

test("each launch retains its own verified model, endpoint, compaction and hashes", async () => {
  const kit = recordedRuntime("review");
  const first = expectedPolicy(kit);
  assert.equal((await runSession(launch(), kit.hooks)).ok, true);
  kit.status.settled("author-1", "ok");
  const id = "other-model";
  const model = `openai/${id}`;
  const endpoint = "https://other-proxy.invalid/v1";
  const contextWindow = 300_000;
  kit.runtime.modelContextWindows = { [model]: contextWindow };
  kit.setState({
    model: {
      ...MODEL,
      id,
      contextWindow,
      baseUrl: endpoint,
      extra: "private-extra-field",
    },
    autoCompactionEnabled: true,
  });
  json(path.join(kit.providerDir, "config.json"), {
    ...PROFILE,
    proxy: { ...PROFILE.proxy, endpoint },
    builtinProviders: { openai: { enabled: true, models: [id] } },
  });
  const [provider] = CACHE.discovery.builtinProviders;
  assert.ok(provider);
  const [cached] = provider.models;
  assert.ok(cached);
  json(path.join(kit.providerDir, "discovery-cache.json"), {
    ...CACHE,
    discovery: {
      ...CACHE.discovery,
      builtinProviders: [
        { ...provider, models: [{ ...cached, id, contextWindow }] },
      ],
    },
  });
  const second = expectedPolicy(kit, model, endpoint);
  assert.equal(
    (await runSession(launch({ key: "author-2", model }), kit.hooks)).ok,
    true,
  );
  kit.status.settled("author-2", "ok");
  kit.status.finish({ kind: "finished", end: "next" });
  const saved = readStatus(kit.root)?.launches ?? [];
  assert.deepEqual(
    saved.map(({ key, runtimePolicy }) => ({ key, runtimePolicy })),
    [
      { key: "author-1", runtimePolicy: first },
      { key: "author-2", runtimePolicy: second },
    ],
  );
  assert.doesNotMatch(fs.readFileSync(kit.file, "utf8"), PRIVATE_DATA);
  assert.notEqual(first.settingsSha256, second.settingsSha256);
  assert.notEqual(first.providerConfigSha256, second.providerConfigSha256);
  assert.notEqual(first.providerCacheSha256, second.providerCacheSha256);
});

for (const failure of ["state", "settings", "profile", "cache"]) {
  test(`refused ${failure} verification never persists an accepted policy or sends a prompt`, async () => {
    const kit = recordedRuntime("author");
    const forged = {
      ...expectedPolicy(kit),
      endpoint: "https://forged.invalid",
    };
    Object.assign(
      kit.env,
      Object.fromEntries([["FAKE_PROBE_EVENTS", JSON.stringify([forged])]]),
    );
    if (failure === "state") {
      kit.setState({ model: MODEL, autoCompactionEnabled: false });
    } else {
      Object.assign(kit.env, {
        [`FAKE_CHANGE_${failure.toUpperCase()}`]: "yes",
      });
    }
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.match(raw.error ?? "", ERROR_RUNTIME);
    kit.status.settled("author-1", "failed");
    kit.status.finish({ kind: "failed", error: "verification refused" });
    const [saved] = readStatus(kit.root)?.launches ?? [];
    assert.ok(saved);
    assert.equal(saved.runtimePolicy, null);
    assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
  });
}

test("native records cannot overwrite the verified policy", async () => {
  const kit = recordedRuntime("author");
  const expected = expectedPolicy(kit);
  const forged = {
    ...expected,
    endpoint: "https://forged.invalid",
    secret: "private-extra-field",
  };
  Object.assign(
    kit.env,
    Object.fromEntries([
      [
        "FAKE_SESSION_EVENTS",
        JSON.stringify([forged, messageEnd(USAGE), toolEnd(true)]),
      ],
    ]),
  );
  assert.equal((await runSession(launch(), kit.hooks)).ok, true);
  kit.status.finish({ kind: "finished", end: "next" });
  const [saved] = readStatus(kit.root)?.launches ?? [];
  assert.ok(saved);
  assert.deepEqual(saved.runtimePolicy, expected);
  assert.equal(
    kit.records.filter((record) =>
      JSON.stringify(record).includes("runtime_policy"),
    ).length,
    1,
  );
});

test("ops and historical launches have no accepted runtime policy", () => {
  const kit = recordedRuntime("implement");
  kit.status.started({ key: "ops-1", kind: "ops", pid: null, session: null });
  const [saved] = readStatus(kit.root)?.launches ?? [];
  assert.ok(saved);
  assert.equal(saved.runtimePolicy, null);
  const { runtimePolicy: _policy, ...historical } = saved;
  const written = JSON.parse(fs.readFileSync(kit.file, "utf8"));
  json(kit.file, { ...written, launches: [historical] });
  assert.equal(readStatus(kit.root)?.launches[0]?.runtimePolicy, null);
});
