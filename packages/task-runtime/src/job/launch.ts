// Run one fresh model session with pinned prompts and isolated credentials.
import fs from "node:fs";
import path from "node:path";
import type { SessionPhase } from "../domain.ts";
import { piArgs, readDefinition } from "./agent-definition.ts";
import type { LiveHandle } from "./control.ts";
import type { PinnedPrompt } from "./prompts.ts";
import type { SessionRaw } from "./raw-results.ts";
import { failedSession, sessionRaw } from "./raw-results.ts";
import type { RpcProcess } from "./rpc.ts";
import { runRpc } from "./rpc.ts";
import type { RuntimeConfig } from "./runtime-policy.ts";
import { runtimeProfile } from "./runtime-profile.ts";
import type { SessionProfile } from "./session-profile.ts";
import type { LaunchStart } from "./status.ts";

interface SessionResources {
  agentDirectory: string;
  outputExtension: string;
  commitExtension: string;
  parentHome: string;
}
const TIME_RADIX = 36;
// What the stage job hears of its launches.
interface LaunchHooks {
  // Where launch `key`'s session JSONL goes.
  sessionFile: (key: string) => string;
  // A launch started; `live` is its pi session or its ops child.
  started: (launch: LaunchStart, live: LiveHandle) => void;
  // Session `key` printed `record`.
  record: (key: string, record: unknown) => void;
  // Launch `key`'s process ended.
  ended: (key: string) => void;
  // The whole environment launch `key`'s session runs with: a commit scope
  // only when the session `commits`, and never a token.
  env: (launch: {
    key: string;
    commits: boolean;
  }) => Readonly<Record<string, string>>;
  // Where every model session runs: the job's own folder.
  cwd: string;
  runtime?: RuntimeConfig;
}

// One model session: its key, the model profile it plays, its installed agent
// and model, its task, the JSON Schema of its reply, its timeout, whether it
// commits (its own write authority), the reviewer phase it is labelled with
// (null for none) and its behavioral prompt, pinned from the installed
// prompt pages, which pi appends to its agent's system prompt and which grants it nothing.
interface SessionLaunch {
  key: string;
  profile: SessionProfile;
  agent: string;
  model: string;
  task: string;
  outputSchema: unknown;
  timeoutMs: number;
  commits: boolean;
  phase: SessionPhase | null;
  prompt: PinnedPrompt;
}

// Readies `launch`'s session files: creates the sessions folder, moves an
// earlier job's session at the same path aside to `<key>.<time>.jsonl`
// (launch keys repeat from job to job) and writes the reply's schema beside
// it. Returns the session and schema files, or null if any of that fails.
function prepareSession(
  launch: SessionLaunch,
  hooks: LaunchHooks,
): { session: string; schema: string } | null {
  const { key } = launch;
  const session = hooks.sessionFile(key);
  const dir = path.dirname(session);
  const schema = path.join(dir, `${key}.schema.json`);
  const time = Date.now().toString(TIME_RADIX);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(session)) {
      fs.renameSync(session, path.join(dir, `${key}.${time}.jsonl`));
    }
    fs.writeFileSync(schema, JSON.stringify(launch.outputSchema));
  } catch {
    return null;
  }
  return { session, schema };
}

// What tells the job that `launch`'s pi, writing `session`, started: its
// record names the session's write authority, phase and pinned prompt.
function spawnedOf(
  launch: SessionLaunch,
  session: string,
  hooks: LaunchHooks,
): (rpc: RpcProcess) => void {
  const { key, commits, phase } = launch;
  const { page, sha256 } = launch.prompt.provenance;
  return (rpc: RpcProcess): void => {
    const start: LaunchStart = {
      key,
      kind: "session",
      pid: rpc.pid,
      session,
      commits,
      phase,
      prompt: { page, sha256 },
    };
    const live: LiveHandle = { kind: "session", session: { key, ...rpc } };
    hooks.started(start, live);
  };
}

// Runs `launch`'s session as its installed agent and resolves to its raw
// result. Only a launch that commits gets pipeline_commit, a commit scope and
// tools that edit or run commands; any other reads only, whatever its
// agent's definition lists (piArgs).
async function runSession(
  launch: SessionLaunch,
  hooks: LaunchHooks,
  resources: SessionResources,
): Promise<SessionRaw> {
  const read = readDefinition(launch.agent, resources.agentDirectory);
  if (read.kind === "missing") {
    return failedSession(launch, read.error);
  }
  const files = prepareSession(launch, hooks);
  if (files === null) {
    const error = `agent ${launch.agent}: cannot prepare its session and schema files`;
    return failedSession(launch, error);
  }
  const { key, model, commits } = launch;
  let commit: string | null = null;
  if (commits) {
    commit = resources.commitExtension;
  }
  const env = hooks.env({ key, commits });
  const runtime = runtimeProfile({
    parentHome: resources.parentHome,
    model,
    runtime: hooks.runtime,
    session: files.session,
    cwd: hooks.cwd,
    env,
  });
  if ("error" in runtime) {
    return failedSession(launch, runtime.error);
  }
  const args = piArgs(read.definition, launch, {
    ...files,
    extension: resources.outputExtension,
    commit,
  });
  args.push("-e", runtime.extension);
  const exit = await runRpc({
    args,
    cwd: hooks.cwd,
    env: runtime.env,
    preflight: {
      policy: runtime.policy,
      endpoint: runtime.endpoint,
      provenance: runtime.provenance,
      verify: runtime.verify,
    },
    prompt: launch.task,
    timeoutMs: launch.timeoutMs,
    onSpawn: spawnedOf(launch, files.session, hooks),
    onRecord: (record: unknown): void => hooks.record(key, record),
  });
  hooks.ended(key);
  return sessionRaw(launch, exit);
}

export type { LaunchHooks, SessionLaunch, SessionResources };
export { runSession };
