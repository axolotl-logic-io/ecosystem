// @ts-check
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { pinnedOf } from "./brain-test-kit.mjs";
import { toolchainRuntime } from "./runtime-toolchain-test-kit.mjs";

/** @import { SessionLaunch } from "../src/job/launch.ts" */
const { runSession } = await import("../src/job/launch.ts");
const { STAGE_AGENTS } = await import("../src/job/roles.ts");
const { RUNTIME_SCHEMA, runtimeBoundary } = await import(
  "../src/job/runtime-policy.ts"
);
const SHIM_EXIT = 127;
const REPORT_COUNT = 3;
const REPORT = z.object({
  home: z.string(),
  cwd: z.string(),
  env: z.array(z.string()),
  toolchain: z.record(z.string(), z.string()),
  tools: z.array(
    z.object({
      name: z.string(),
      selected: z.string(),
      status: z.number(),
      version: z.string(),
    }),
  ),
});
const HIDDEN = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "MERGE_TOKEN",
  "ISSUE_PIPELINE_DEV_GITHUB_TOKEN",
  "ISSUE_PIPELINE_MERGE_GITHUB_TOKEN",
  "OPENAI_API_KEY",
];
const HOSTILE_ENV = Object.fromEntries([
  ["OPENAI_API_KEY", "undeclared-openai"],
  ["ISSUE_PIPELINE_DEV_GITHUB_TOKEN", "forbidden-dev"],
  ["ISSUE_PIPELINE_MERGE_GITHUB_TOKEN", "forbidden-merge"],
  ["GITHUB_TOKEN", "forbidden-github"],
]);

/** @param {Partial<SessionLaunch>} spec @returns {SessionLaunch} */
function launch(spec) {
  return {
    key: "toolchain",
    role: "author",
    agent: "issue-pipeline-author",
    phase: null,
    commits: false,
    model: "openai/gpt-6.1-sol",
    task: "Offline fixture",
    timeoutMs: 3000,
    outputSchema: { type: "object" },
    prompt: pinnedOf("Pipeline-Prompt-Developer.md"),
    ...spec,
  };
}

/** @param {ReturnType<typeof toolchainRuntime>} kit @param {Partial<SessionLaunch>} spec */
async function startSession(kit, spec) {
  Object.assign(kit.env, HOSTILE_ENV);
  kit.runtime.toolchainEnv = RUNTIME_SCHEMA.parse({
    toolchainEnv: kit.toolchain,
  }).toolchainEnv;
  return await runSession(launch(spec), kit.hooks);
}

for (const shims of [true, false]) {
  test(`fixture HOME dependence, shims ${shims}`, () => {
    const kit = toolchainRuntime(shims);

    for (const home of [kit.operatorHome, kit.runtime.home]) {
      assert.ok(home);
      const probe = spawnSync("pi", ["--version", "--offline"], {
        cwd: kit.root,
        encoding: "utf8",
        timeout: 3000,
        env: {
          ...kit.env,
          ...Object.fromEntries([
            ["FAKE_TOOLCHAIN_REPORT", ""],
            ["HOME", home],
          ]),
        },
      });
      let status = 0;
      let stderr = "";
      if (shims && home === kit.runtime.home) {
        status = SHIM_EXIT;
        stderr = "No version is set for shim: node\n";
      }
      assert.equal(probe.status, status);
      assert.equal(probe.stderr, stderr);
    }
  });
  for (const [stage, entry] of Object.entries(STAGE_AGENTS)) {
    for (const session of entry.sessions) {
      const spec = { role: entry.role, agent: entry.agent, ...session };
      test(`selected tools for ${stage} ${session.phase ?? "unphased"}, shims ${shims}`, async () => {
        const kit = toolchainRuntime(shims);
        const originalEnv = { ...process.env };
        Object.assign(kit.env, HOSTILE_ENV);
        assert.equal(kit.comparison().status, 0);
        // The declaration, not an accidentally usable inherited PATH, selects Pi.
        Object.assign(
          kit.env,
          Object.fromEntries([["PATH", path.join(kit.root, "unselected")]]),
        );
        const inputEnv = { ...kit.env };
        const raw = await startSession(kit, spec);
        assert.equal(raw.ok, true, raw.error ?? "");
        assert.deepEqual(
          runtimeBoundary(kit.runtime, {}).toolchainEnv,
          kit.toolchain,
        );

        const reports = REPORT.array().parse(kit.reports());
        assert.equal(reports.length, REPORT_COUNT);
        const [expected, ...children] = reports;
        assert.ok(expected);
        assert.equal(expected.home, kit.operatorHome);
        for (const child of children) {
          assert.equal(child.home, kit.runtime.home);
          assert.equal(child.cwd, expected.cwd);
          assert.equal(child.cwd, fs.realpathSync(kit.root));
          assert.deepEqual(child.tools, expected.tools);
          assert.deepEqual(child.toolchain, kit.toolchain);
          assert.ok(child.tools.every((tool) => tool.status === 0));
          // Inspect the version probe as well as RPC/tool descendants, without
          // recording credential contents in the fixture's diagnostics.
          for (const name of HIDDEN) {
            assert.ok(!child.env.includes(name));
          }
          assert.ok(child.env.includes("PIPELINE_MODEL_KEY"));
        }
        assert.ok(
          JSON.stringify(Object.entries(process.env).sort()) ===
            JSON.stringify(Object.entries(originalEnv).sort()),
          "the parent process environment must remain unchanged",
        );
        assert.deepEqual(kit.env, inputEnv);
      });
      test(`policy refusal for ${stage} ${session.phase ?? "unphased"}, shims ${shims}`, async () => {
        const kit = toolchainRuntime(shims);
        Object.assign(
          kit.env,
          Object.fromEntries([["FAKE_CHANGE_SETTINGS", "yes"]]),
        );
        const raw = await startSession(kit, spec);
        assert.equal(raw.ok, false);
        assert.ok(raw.error?.includes("changed before the first prompt"));
        assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
      });
      test(`isolated profile for ${stage} ${session.phase ?? "unphased"}, shims ${shims}`, async () => {
        const kit = toolchainRuntime(shims);
        const raw = await startSession(kit, spec);
        assert.equal(raw.ok, true, raw.error ?? "");

        const [start, ...commands] = kit.calls();
        assert.ok(start);
        assert.deepEqual(commands, [
          { command: "get_state" },
          { command: "prompt" },
        ]);
        const { agentDir, settings, env } = start;
        assert.ok(typeof agentDir === "string");
        assert.deepEqual(fs.readdirSync(agentDir), ["settings.json"]);
        assert.notEqual(agentDir, path.join(kit.operatorHome, ".pi", "agent"));
        assert.deepEqual(settings, {
          compaction: {
            enabled: true,
            reserveTokens: 97_000,
            keepRecentTokens: 30_000,
          },
        });
        assert.ok(Array.isArray(env));
        for (const name of HIDDEN) {
          assert.ok(!env.includes(name));
        }
        assert.ok(env.includes("PIPELINE_MODEL_KEY"));
        assert.equal(
          fs.readFileSync(
            path.join(kit.operatorHome, ".pi", "agent", "auth.json"),
            "utf8",
          ),
          '{"personal":"synthetic-personal-auth"}',
        );
      });
    }
  }
}

for (const overridePath of [false, true]) {
  test(`inherited HOME-independent locations survive a partial declaration, PATH override ${overridePath}`, async () => {
    const kit = toolchainRuntime(true);
    Object.assign(kit.env, kit.toolchain, HOSTILE_ENV);
    assert.equal(kit.comparison().status, 0);
    let toolchainEnv = {};
    if (overridePath) {
      toolchainEnv = Object.fromEntries(
        Object.entries(kit.toolchain).filter(([name]) => name === "PATH"),
      );
      Object.assign(
        kit.env,
        Object.fromEntries([["PATH", path.join(kit.root, "unselected")]]),
      );
    }
    kit.runtime.toolchainEnv = RUNTIME_SCHEMA.parse({
      toolchainEnv,
    }).toolchainEnv;
    const inputEnv = { ...kit.env };
    const raw = await runSession(launch({}), kit.hooks);
    assert.equal(raw.ok, true, raw.error ?? "");
    const [expected, ...children] = REPORT.array().parse(kit.reports());
    assert.ok(expected);
    assert.equal(children.length, REPORT_COUNT - 1);
    for (const child of children) {
      assert.equal(child.home, kit.runtime.home);
      assert.equal(child.cwd, expected.cwd);
      assert.deepEqual(child.tools, expected.tools);
      assert.deepEqual(child.toolchain, kit.toolchain);
      assert.ok(child.tools.every((tool) => tool.status === 0));
      for (const name of HIDDEN) {
        assert.ok(!child.env.includes(name));
      }
    }
    assert.deepEqual(kit.env, inputEnv);
  });
}

for (const [name, value] of [
  ["HOME", "/elsewhere"],
  ["GH_TOKEN", "synthetic"],
  ["OPENAI_API_KEY", "synthetic"],
  ["PATH", "relative:/bin"],
  ["PATH", "/bin:"],
  ["MISE_STATE_DIR", "~/state"],
]) {
  test(`toolchain declaration refuses ${name} with an unsupported value`, () => {
    const toolchainEnv = Object.fromEntries([[name, value]]);
    assert.equal(RUNTIME_SCHEMA.safeParse({ toolchainEnv }).success, false);
  });
}

for (const name of ["PATH", "MISE_STATE_DIR"]) {
  test(`a declared toolchain location cannot also be the ${name} model credential`, async () => {
    const kit = toolchainRuntime(true);
    kit.runtime.credentialEnv.push(name);
    const raw = await startSession(kit, {});
    assert.equal(raw.ok, false);
    assert.ok(
      raw.error?.includes(
        "model credentials must not name pipeline-managed environment variables",
      ),
    );
    assert.deepEqual(kit.calls(), []);
    assert.deepEqual(kit.records, []);
    assert.ok(!fs.existsSync(path.join(kit.root, "version-calls.txt")));
  });
}
