// @ts-check
// Opt-in, no-prompt proof against a specifically supplied native package.
// Not in npm test: supply reviewed native and provider package directories.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { z } from "zod";
import { isolatedRoot } from "./isolated-root-test-kit.mjs";
import { FIXTURE_WINDOWS } from "./runtime-fixtures.mjs";

const { nativeSettings, policyOf, RUNTIME_SCHEMA } = await import(
  "../src/job/runtime-policy.ts"
);
const [nativeDirectory, providerDirectory] = process.argv.slice(2);
const nativeRoot = z.string().startsWith("/").parse(nativeDirectory);
const manifest = z.object({
  name: z.literal("@earendil-works/pi-coding-agent"),
  version: z.literal("1.2.0"),
});
manifest.parse(
  JSON.parse(fs.readFileSync(path.join(nativeRoot, "package.json"), "utf8")),
);
const providerRoot = z.string().startsWith("/").parse(providerDirectory);
z.object({
  name: z.literal("pi-cliproxyapi"),
  version: z.literal("0.4.3"),
}).parse(
  JSON.parse(fs.readFileSync(path.join(providerRoot, "package.json"), "utf8")),
);
const exampleFile = new URL(
  "../runtime/pi-cliproxyapi-config.example.json",
  import.meta.url,
).pathname;
const TIMEOUT_MS = 20_000;
const NATIVE_WINDOW = 272_000;
const STATE_RESPONSE = z.object({
  id: z.literal("proof"),
  success: z.literal(true),
  data: z.object({
    autoCompactionEnabled: z.literal(true),
    model: z.object({
      provider: z.literal("offline-proof"),
      id: z.literal("offline"),
      contextWindow: z.literal(NATIVE_WINDOW),
    }),
  }),
});

const CONFLICTING_SETTINGS = JSON.stringify({
  compaction: {
    enabled: false,
    modelOverrides: {
      "openai/gpt-6.1-sol": { reserveTokens: 1, keepRecentTokens: 1 },
    },
  },
});

const DENY = `const fail=()=>{require("node:fs").appendFileSync(process.env.PROOF_DENIED,"external operation attempted\\n");throw new Error("external operation denied")};globalThis.fetch=fail;require("node:net").Socket.prototype.connect=fail;require("node:tls").connect=fail;for(const name of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"])require("node:child_process")[name]=fail;`;
const PROVIDER = `export default function(pi) {
  pi.registerProvider("offline-proof", {
    baseUrl: "https://never.invalid/v1", apiKey: "never-a-secret", api: "openai-responses",
    streamSimple() { throw new Error("generation is forbidden in this proof"); },
    models: [{id:"offline",name:"Offline proof",reasoning:false,input:["text"],
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:272000,maxTokens:32000}]
  });
}`;

// This tests native trigger/settings APIs and compaction-entry persistence,
// not summary generation. No provider is registered or called by this code.
const SDK_PROOF = `import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path"; import {pathToFileURL} from "node:url";
const [nativeRoot,cwd,agent,providerRoot,exampleFile] = process.argv.slice(2);
const {resolveConfigValue:resolveProvider} = await import(pathToFileURL(path.join(providerRoot,"src/config.ts")).href);
const load = (name) => import(pathToFileURL(path.join(nativeRoot,"dist/core",name)).href);
const {SettingsManager} = await load("settings-manager.js");
const {resolveConfigValue:resolveNative} = await load("resolve-config-value.js");
const profile = JSON.parse(fs.readFileSync(exampleFile,"utf8"));
const expected = "opaque-proof-token";
process.env.PIPELINE_MODEL_KEY = expected;
assert.equal(profile.proxy.apiKey,"$PIPELINE_MODEL_KEY");
assert.equal(resolveProvider(profile.proxy.apiKey),expected);
assert.equal(resolveNative(resolveProvider(profile.proxy.apiKey)),expected);
assert.equal(resolveProvider("PIPELINE_MODEL_KEY"),"PIPELINE_MODEL_KEY");
assert.equal(resolveNative("PIPELINE_MODEL_KEY"),"PIPELINE_MODEL_KEY");
assert.equal(resolveProvider("\${PIPELINE_MODEL_KEY}"),"");
const {shouldCompact} = await load("compaction/compaction.js");
const {SessionManager} = await load("session-manager.js");
const settings = SettingsManager.create(cwd,agent,{projectTrusted:false}).getCompactionSettings({provider:"openai",id:"gpt-6.1-sol"});
assert.deepEqual(settings,{enabled:true,reserveTokens:97000,keepRecentTokens:30000});
assert.equal(shouldCompact(175000,272000,settings),false);
assert.equal(shouldCompact(175001,272000,settings),true);
const session = SessionManager.create(cwd,path.join(cwd,"sessions"));
const id = session.getSessionId(); const file = session.getSessionFile();
session.appendMessage({role:"user",content:"older-history",timestamp:1});
session.appendMessage({role:"assistant",content:[{type:"text",text:"older-answer"}],api:"openai-responses",provider:"offline",model:"offline",stopReason:"stop",timestamp:2,
usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
const kept = session.appendMessage({role:"user",content:"recent-history",timestamp:3});
session.appendCompaction("synthetic native compaction summary",kept,175001);
session.appendMessage({role:"user",content:"same-session-continuation",timestamp:4});
assert.equal(session.getSessionId(),id); assert.equal(session.getSessionFile(),file);
const reopened = SessionManager.open(file);
assert.equal(reopened.getSessionId(),id);
const context = JSON.stringify(reopened.buildSessionContext());
assert.ok(context.includes("synthetic native compaction summary")); assert.ok(context.includes("recent-history"));
assert.ok(context.includes("same-session-continuation")); assert.ok(!context.includes("older-history"));
assert.ok(fs.readFileSync(file,"utf8").includes("older-history"));
process.stdout.write("native trigger and append-only compaction persistence passed\\n");
`;

/** @returns {{ root: string, cwd: string, agent: string, env: Record<string, string>, guard: string, denied: string }} */
function fixture() {
  const root = fs.mkdtempSync(path.join(isolatedRoot, "native-proof-"));
  const cwd = path.join(root, "cwd");
  const agent = path.join(root, "agent");
  const home = path.join(root, "home");
  for (const dir of [cwd, agent, home]) {
    fs.mkdirSync(dir);
  }
  fs.mkdirSync(path.join(home, ".pi", "agent", "extensions"), {
    recursive: true,
  });
  for (const dir of [path.join(home, ".pi", "agent"), path.join(cwd, ".pi")]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.json"), CONFLICTING_SETTINGS);
  }
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "extensions", "must-not-load.mjs"),
    'throw new Error("personal extension must never load");',
  );
  fs.writeFileSync(
    path.join(agent, "settings.json"),
    JSON.stringify(
      nativeSettings(
        policyOf(
          "openai/gpt-6.1-sol",
          RUNTIME_SCHEMA.parse({ modelContextWindows: FIXTURE_WINDOWS }),
        ),
      ),
    ),
  );
  const guard = path.join(root, "deny.cjs");
  const denied = path.join(root, "external-operation.txt");
  fs.writeFileSync(guard, DENY);
  const env = Object.fromEntries([
    ["HOME", home],
    ["PATH", "/nonexistent"],
    ["PI_CODING_AGENT_DIR", agent],
    ["PI_CODING_AGENT_SESSION_DIR", path.join(root, "sessions")],
    ["PI_OFFLINE", "1"],
    ["PI_SKIP_VERSION_CHECK", "1"],
    ["PI_TELEMETRY", "0"],
    ["PROOF_DENIED", denied],
  ]);
  return { root, cwd, agent, env, guard, denied };
}

test("native explicit RPC wins over print without prompt, network or subprocess", () => {
  const kit = fixture();
  const provider = path.join(kit.root, "provider.mjs");
  fs.writeFileSync(provider, PROVIDER);
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      kit.guard,
      path.join(nativeRoot, "dist/cli.js"),
      "--mode",
      "rpc",
      "--print",
      "--offline",
      "--no-approve",
      "--no-extensions",
      "-e",
      provider,
      "-nc",
      "-ns",
      "-np",
      "--no-themes",
      "--no-session",
      "--model",
      "offline-proof/offline",
    ],
    {
      cwd: kit.cwd,
      env: kit.env,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      input: '{"id":"proof","type":"get_state"}\n',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const states = result.stdout
    .trim()
    .split("\n")
    .map((line) => STATE_RESPONSE.safeParse(JSON.parse(line)));
  assert.ok(states.some((state) => state.success));
  assert.equal(fs.existsSync(kit.denied), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(kit.agent, "settings.json"), "utf8")),
    nativeSettings(
      policyOf(
        "openai/gpt-6.1-sol",
        RUNTIME_SCHEMA.parse({ modelContextWindows: FIXTURE_WINDOWS }),
      ),
    ),
  );
});

// Node cannot strip installed TypeScript under node_modules. Copy these exact
// two source files, without transformation or provider startup, into the fixture.
/** @param {string} root @returns {string} */
function copiedResolver(root) {
  const target = path.join(root, "provider-source");
  fs.mkdirSync(path.join(target, "src"), { recursive: true });
  for (const name of ["config.ts", "log.ts"]) {
    fs.copyFileSync(
      path.join(providerRoot, "src", name),
      path.join(target, "src", name),
    );
  }
  return target;
}

test("native auth resolution, threshold and same-session retained context persist without generation", () => {
  const kit = fixture();
  const proof = path.join(kit.root, "sdk-proof.mjs");
  fs.writeFileSync(proof, SDK_PROOF);
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      kit.guard,
      proof,
      nativeRoot,
      kit.cwd,
      kit.agent,
      copiedResolver(kit.root),
      exampleFile,
    ],
    { cwd: kit.cwd, env: kit.env, encoding: "utf8", timeout: TIMEOUT_MS },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes("append-only compaction persistence passed"),
  );
  assert.equal(fs.existsSync(kit.denied), false);
});
