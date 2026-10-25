// Default-deny private runtime: fake pi never loads an extension or reaches a
// model. Its only external input is the explicitly created local state file.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { LaunchHooks, SessionLaunch } from "../../src/job/launch.ts";
import type { RuntimeConfig } from "../../src/job/runtime-policy.ts";
import { isolatedRoot } from "../isolated-root-test-kit.ts";
import { pinnedOf } from "../prompt-test-kit.ts";
import { FIXTURE_WINDOWS } from "../runtime-fixtures.ts";

const { RUNTIME_SCHEMA }: typeof import("../../src/job/runtime-policy.ts") =
  await import("../../src/job/runtime-policy.ts");
const {
  agentEnvOf,
  rolesOf,
  STAGE_AGENTS,
}: typeof import("../../src/job/roles.ts") = await import(
  "../../src/job/roles.ts"
);

const { AGENT_DIR }: typeof import("../../src/pipeline-root.ts") = await import(
  "../../src/pipeline-root.ts"
);
fs.mkdirSync(path.join(AGENT_DIR, "agents", "issue-pipeline"), {
  recursive: true,
});
for (const { agent } of Object.values(STAGE_AGENTS)) {
  fs.copyFileSync(
    new URL(`../../agents/${agent}.md`, import.meta.url),
    path.join(AGENT_DIR, "agents", "issue-pipeline", `${agent}.md`),
  );
}

const MODEL = {
  id: "gpt-6.1-sol",
  provider: "openai",
  contextWindow: 272_000,
  baseUrl: "https://proxy.invalid/v1",
  api: "openai-responses",
  headers: { authorization: "private-native-header-sentinel" },
};

const PROFILE: {
  proxy: { endpoint: string; apiKey: string };
  builtinProviders: { openai: { enabled: boolean; models: string[] } };
} = {
  proxy: { endpoint: MODEL.baseUrl, apiKey: "$PIPELINE_MODEL_KEY" },
  builtinProviders: { openai: { enabled: true, models: [MODEL.id] } },
};

// A model the provider's discovery cache lists.
interface CachedModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// The provider's discovery-cache.json: when it was saved and what its
// discovery found, each built-in provider with the models it serves.
interface DiscoveryCache {
  savedAt: number;
  discovery: {
    source: string;
    upstreamVersion: string | null;
    serverDiscoveryExcludes: unknown[];
    upstreamTotal: number;
    customPool: unknown[];
    builtinProviders: { name: string; api: string; models: CachedModel[] }[];
  };
}

const CACHE: DiscoveryCache = {
  savedAt: 1,
  discovery: {
    source: "well-known",
    upstreamVersion: null,
    serverDiscoveryExcludes: [],
    upstreamTotal: 1,
    customPool: [],
    builtinProviders: [
      {
        name: "openai",
        api: "openai-responses",
        models: [
          {
            id: MODEL.id,
            name: "Offline fixture",
            reasoning: true,
            contextWindow: MODEL.contextWindow,
            maxTokens: 32_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ],
  },
};

const FAKE = `#!${process.execPath}
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
// Opt-in: what the probe or RPC child's ordinary tool children resolve.
const reportToolchain = () => {
  if (!process.env.FAKE_TOOLCHAIN_REPORT) return;
  const names = ["PATH", "MISE_DATA_DIR", "MISE_STATE_DIR", "MISE_CACHE_DIR", "MISE_CONFIG_DIR", "MISE_GLOBAL_CONFIG_FILE"];
  const tools = ["node", "npm", "mise"].map((name) => {
    const result = spawnSync("/bin/sh", ["-c", name + " --version"], {env: process.env, cwd: process.cwd(), encoding: "utf8", timeout: 3000});
    const selected = spawnSync("/bin/sh", ["-c", "command -v " + name], {env: process.env, cwd: process.cwd(), encoding: "utf8", timeout: 3000});
    return {name, selected: selected.stdout.trim(), status: result.status, version: result.stdout.trim()};
  });
  fs.appendFileSync(process.env.FAKE_TOOLCHAIN_REPORT, JSON.stringify({home: process.env.HOME, cwd: process.cwd(), env: Object.keys(process.env), tools, toolchain: Object.fromEntries(names.map((name) => [name, process.env[name]]))}) + "\\n");
};
if (args[0] === "--version") {
  reportToolchain();
  fs.appendFileSync(path.join(process.env.PRIVATE_RUNTIME_ROOT, "version-calls.txt"), "version\\n");
  if (args.join(" ") !== "--version --offline") throw new Error("unsupported version command");
  process.stdout.write((process.env.FAKE_NATIVE_VERSION ?? "1.2.0") + "\\n");
} else {
  for (const flag of ["--print", "--offline", "--no-approve", "--no-extensions", "-nc", "-ns", "-np", "--no-themes"]) {
    if (!args.includes(flag)) throw new Error("missing isolation flag");
  }
  if (args[args.indexOf("--mode") + 1] !== "rpc") throw new Error("not RPC");
  const root = process.env.PRIVATE_RUNTIME_ROOT;
  const log = (value) => fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify(value) + "\\n");
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
  log({args, home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR, settings,
    env: Object.keys(process.env), scope: process.env.ISSUE_PIPELINE_COMMIT_SCOPE ?? null});
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
      const command = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      const logged = {command: command.type};
      if (command.type === "prompt" && process.env.FAKE_STATUS_FILE) {
        logged.policyAtPrompt = JSON.parse(fs.readFileSync(process.env.FAKE_STATUS_FILE, "utf8")).launches.at(-1).runtimePolicy;
      }
      log(logged);
      const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
      if (command.type === "get_state") {
        for (const event of JSON.parse(process.env.FAKE_BEFORE_PROBE_EVENTS ?? "[]")) send(event);
        if (process.env.FAKE_PROBE === "missing") { process.exit(0); }
        if (process.env.FAKE_CHANGE_CACHE === "yes") {
          fs.writeFileSync(path.join(process.env.HOME, ".pi", "agent", "pi-cliproxyapi", "discovery-cache.json"), "{}");
        }
        if (process.env.FAKE_CHANGE_SETTINGS === "yes") {
          fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({compaction:{enabled:true,reserveTokens:1,keepRecentTokens:1}}));
        }
        if (process.env.FAKE_CHANGE_PROFILE === "yes") {
          fs.writeFileSync(path.join(process.env.HOME, ".pi", "agent", "pi-cliproxyapi", "config.json"), "{}");
        }
        const state = JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
        if (process.env.FAKE_PROBE === "ack") {
          send({id: command.id, type: "response", command: "get_state", success: true});
        } else {
          send({id: process.env.FAKE_PROBE === "uncorrelated" ? "other" : command.id, type: "response", command: "get_state", success: true, data: state});
        }
        for (const event of JSON.parse(process.env.FAKE_PROBE_EVENTS ?? "[]")) send(event);
      } else if (command.type === "prompt") {
        reportToolchain();
        send({id: command.id, type: "response", command: "prompt", success: true, data: {disposition: "started"}});
        send({type: "auto_compaction_start", reason: "threshold"});
        send({type: "auto_compaction_end", result: {summary: "native event fixture"}});
        for (const event of JSON.parse(process.env.FAKE_SESSION_EVENTS ?? "[]")) send(event);
        if (process.env.FAKE_SESSION_FAILURE === "yes") process.exit(1);
        send({type: "tool_execution_end", toolName: "structured_output", toolCallId: "answer", isError: false, result: {content: [], details: {ok: true}}});
        send({type: "agent_settled"});
      } else if (command.type === "abort") {
        send({id: command.id, type: "response", command: "abort", success: true});
      } else { throw new Error("unsupported RPC command"); }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
`;

function json(file: string, value: unknown): void {
  fs.writeFileSync(file, JSON.stringify(value));
}

function provisionRuntime(): {
  root: string;
  providerDir: string;
  bin: string;
  runtime: RuntimeConfig;
} {
  const root = fs.mkdtempSync(path.join(isolatedRoot, "runtime-"));
  const home = path.join(root, "home");
  const providerDir = path.join(home, ".pi", "agent", "pi-cliproxyapi");
  const extensionDir = path.join(root, "provider");
  const bin = path.join(root, "bin");
  for (const dir of [providerDir, extensionDir, bin]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(extensionDir, "index.ts"),
    "throw new Error('extension loading forbidden in fake pi');",
  );
  json(path.join(extensionDir, "package.json"), {
    name: "pi-cliproxyapi",
    version: "0.4.3",
  });
  json(path.join(providerDir, "config.json"), PROFILE);
  json(path.join(providerDir, "discovery-cache.json"), CACHE);
  json(path.join(root, "state.json"), {
    model: MODEL,
    autoCompactionEnabled: true,
  });
  fs.writeFileSync(path.join(bin, "pi"), FAKE, { mode: 0o700 });
  // Neither personal nor trusted project settings may participate.
  json(path.join(home, ".pi", "agent", "settings.json"), {
    compaction: {
      enabled: false,
      modelOverrides: {
        "openai/gpt-6.1-sol": { reserveTokens: 1, keepRecentTokens: 1 },
      },
    },
  });
  fs.mkdirSync(path.join(root, ".pi"));
  json(path.join(root, ".pi", "settings.json"), {
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
  });
  const runtime = RUNTIME_SCHEMA.parse({
    home,
    modelContextWindows: FIXTURE_WINDOWS,
    providerExtension: path.join(extensionDir, "index.ts"),
  });
  return { root, providerDir, bin, runtime };
}

function privateRuntime(): {
  root: string;
  providerDir: string;
  runtime: RuntimeConfig;
  hooks: LaunchHooks;
  records: unknown[];
  env: Record<string, string>;
  setState: (state: unknown) => void;
  calls: () => Record<string, unknown>[];
} {
  const { root, providerDir, bin, runtime } = provisionRuntime();
  const env = Object.fromEntries([
    ["PATH", bin],
    ["PRIVATE_RUNTIME_ROOT", root],
    ["PIPELINE_MODEL_KEY", "private-credential-sentinel"],
    ["GH_TOKEN", "forbidden-job-token"],
    ["MERGE_TOKEN", "forbidden-role-token"],
  ]);
  const records: unknown[] = [];
  const hooks: LaunchHooks = {
    runtime,
    cwd: root,
    repo: root,
    sessionFile: (key: string) => path.join(root, `${key}.jsonl`),
    started: () => undefined,
    ended: () => undefined,
    sessionEnded: () => undefined,
    record: (_key: string, record: unknown) => records.push(record),
    env: ({ commits }: { key: string; commits: boolean }) => {
      const shared = agentEnvOf(
        rolesOf({ merger: { tokenEnv: "MERGE_TOKEN" } }),
        env,
      );
      if (commits) {
        return {
          ...shared,
          ...Object.fromEntries([
            ["ISSUE_PIPELINE_COMMIT_SCOPE", "writer-scope"],
          ]),
        };
      }
      return shared;
    },
  };
  return {
    root,
    providerDir,
    runtime,
    hooks,
    records,
    env,
    setState: (state: unknown) => json(path.join(root, "state.json"), state),
    calls: (): Record<string, unknown>[] => {
      const file = path.join(root, "calls.jsonl");
      if (!fs.existsSync(file)) {
        return [];
      }
      return fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

function launch(changes: Partial<SessionLaunch> = {}): SessionLaunch {
  return {
    key: "author-1",
    role: "author",
    agent: "issue-pipeline-author",
    model: "openai/gpt-6.1-sol",
    task: "Offline fixture task",
    outputSchema: { type: "object" },
    timeoutMs: 3000,
    commits: false,
    phase: null,
    prompt: pinnedOf("author.md"),
    ...changes,
  };
}

export { CACHE, json, launch, MODEL, PROFILE, privateRuntime };
