// Issue #108: a session's pi, node, npm and mise resolve the same under the
// dedicated runtime HOME as under the operator HOME when runtime.toolchainEnv
// declares the toolchain, without inheriting credentials or personal Pi files.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { launch } from "./runtime-policy-test-kit.ts";
import type { ToolchainKit } from "./runtime-toolchain-test-kit.ts";
import { toolchainRuntime } from "./runtime-toolchain-test-kit.ts";

const { runSession }: typeof import("../../src/job/launch.ts") = await import(
  "../../src/job/launch.ts"
);
const { STAGE_AGENTS }: typeof import("../../src/job/roles.ts") = await import(
  "../../src/job/roles.ts"
);
const { RUNTIME_SCHEMA }: typeof import("../../src/job/runtime-policy.ts") =
  await import("../../src/job/runtime-policy.ts");
const NATIVE_VERSION_REFUSAL = /must report version 1\.2\.0/u;
// The operator baseline, the version probe and the RPC child at its prompt.
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
type Tool = z.infer<typeof REPORT>["tools"][number];
// Where a runtime process ran and what its tools resolved; the expected
// runtime HOME is the runtime's, which may be unset.
interface Where {
  home: string | null;
  cwd: string;
  tools: Tool[];
  toolchain: Record<string, string>;
}
// A runtime child's, with the hidden names its env had and whether it had
// the model key.
interface ChildWhere extends Where {
  hidden: string[];
  modelKey: boolean;
}
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

function declare(
  kit: ToolchainKit,
  toolchainEnv: Record<string, string>,
): void {
  kit.runtime.toolchainEnv = RUNTIME_SCHEMA.parse({
    toolchainEnv,
  }).toolchainEnv;
}

function hideInheritedPath(kit: ToolchainKit): void {
  // The declaration, not an accidentally usable inherited PATH, selects Pi.
  Object.assign(
    kit.env,
    Object.fromEntries([["PATH", path.join(kit.root, "unselected")]]),
  );
}

// Where the operator baseline, then the probe and RPC child, ran and what
// their tools resolved. Only the children's environment is filtered.
function toolchainOutcome(kit: ToolchainKit): {
  baseline: Where | undefined;
  children: ChildWhere[];
} {
  const [baseline, ...children] = REPORT.array().parse(kit.reports());
  return {
    baseline: baseline && {
      home: baseline.home,
      cwd: baseline.cwd,
      tools: baseline.tools,
      toolchain: baseline.toolchain,
    },
    children: children.map((child) => ({
      home: child.home,
      cwd: child.cwd,
      tools: child.tools,
      toolchain: child.toolchain,
      hidden: HIDDEN.filter((name) => child.env.includes(name)),
      modelKey: child.env.includes("PIPELINE_MODEL_KEY"),
    })),
  };
}

// Both runtime children resolve the operator baseline's tools and locations
// under the runtime HOME, with the existing credential filtering.
function operatorOutcome(kit: ToolchainKit): {
  baseline: Where;
  children: ChildWhere[];
} {
  const { PATH: bin = "" } = kit.toolchain;
  const tools = [
    { name: "node", version: process.version },
    { name: "npm", version: "npm-fixture-1.0" },
    { name: "mise", version: "mise-fixture-1.0" },
  ].map(({ name, version }) => ({
    name,
    selected: path.join(bin, name),
    status: 0,
    version,
  }));
  const where = { cwd: fs.realpathSync(kit.root), tools };
  const child = {
    home: kit.runtime.home,
    ...where,
    toolchain: kit.toolchain,
    hidden: [],
    modelKey: true,
  };
  return {
    baseline: { home: kit.operatorHome, ...where, toolchain: kit.toolchain },
    children: Array.from({ length: REPORT_COUNT - 1 }, () => child),
  };
}

test("a HOME-relative node shim refuses the session without a declared toolchain", async () => {
  const kit = toolchainRuntime(true);
  assert.equal(kit.comparison().status, 0);
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.match(raw.error ?? "", NATIVE_VERSION_REFUSAL);
  assert.deepEqual(kit.calls(), []);
});

for (const shims of [true, false]) {
  for (const [stage, entry] of Object.entries(STAGE_AGENTS)) {
    for (const session of entry.sessions) {
      test(`${stage} ${session.phase ?? "unphased"} session selects the declared toolchain, shims ${shims}`, async () => {
        const kit = toolchainRuntime(shims);
        const originalEnv = { ...process.env };
        Object.assign(kit.env, HOSTILE_ENV);
        assert.equal(kit.comparison().status, 0);
        hideInheritedPath(kit);
        declare(kit, kit.toolchain);
        const inputEnv = { ...kit.env };
        const raw = await runSession(
          launch({ role: entry.role, agent: entry.agent, ...session }),
          kit.hooks,
        );
        assert.equal(raw.ok, true, raw.error ?? "");
        assert.deepEqual(toolchainOutcome(kit), operatorOutcome(kit));
        assert.deepEqual(kit.calls().slice(1), [
          { command: "get_state" },
          { command: "prompt" },
        ]);
        assert.deepEqual({ ...process.env }, originalEnv);
        assert.deepEqual(kit.env, inputEnv);
      });
    }
  }
}

test("a declared toolchain keeps the private agent directory and personal profile untouched", async () => {
  const kit = toolchainRuntime(true);
  declare(kit, kit.toolchain);
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, true, raw.error ?? "");
  const [start] = kit.calls();
  assert.ok(start);
  const { agentDir } = start;
  assert.ok(typeof agentDir === "string");
  assert.deepEqual(fs.readdirSync(agentDir), ["settings.json"]);
  assert.notEqual(agentDir, path.join(kit.operatorHome, ".pi", "agent"));
  assert.equal(
    fs.readFileSync(
      path.join(kit.operatorHome, ".pi", "agent", "auth.json"),
      "utf8",
    ),
    '{"personal":"synthetic-personal-auth"}',
  );
});

test("a declared toolchain still refuses changed settings before the prompt", async () => {
  const kit = toolchainRuntime(true);
  Object.assign(kit.env, Object.fromEntries([["FAKE_CHANGE_SETTINGS", "yes"]]));
  declare(kit, kit.toolchain);
  const raw = await runSession(launch(), kit.hooks);
  assert.equal(raw.ok, false);
  assert.ok(raw.error?.includes("changed before the first prompt"));
  assert.deepEqual(kit.calls().slice(1), [{ command: "get_state" }]);
});

for (const overridePath of [false, true]) {
  test(`inherited HOME-independent mise locations survive a partial declaration, PATH declared ${overridePath}`, async () => {
    const kit = toolchainRuntime(true);
    Object.assign(kit.env, kit.toolchain, HOSTILE_ENV);
    assert.equal(kit.comparison().status, 0);
    let toolchainEnv: Record<string, string> = {};
    if (overridePath) {
      const { PATH = "" } = kit.toolchain;
      toolchainEnv = Object.fromEntries([["PATH", PATH]]);
      hideInheritedPath(kit);
    }
    declare(kit, toolchainEnv);
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, true, raw.error ?? "");
    assert.deepEqual(toolchainOutcome(kit), operatorOutcome(kit));
  });
}

for (const name of ["PATH", "MISE_STATE_DIR"]) {
  test(`a declared toolchain location cannot also be the ${name} model credential`, async () => {
    const kit = toolchainRuntime(true);
    declare(kit, kit.toolchain);
    kit.runtime.credentialEnv.push(name);
    const raw = await runSession(launch(), kit.hooks);
    assert.equal(raw.ok, false);
    assert.ok(
      raw.error?.includes(
        "model credentials must not name pipeline-managed environment variables",
      ),
    );
    assert.deepEqual(kit.calls(), []);
    assert.ok(!fs.existsSync(path.join(kit.root, "version-calls.txt")));
  });
}
