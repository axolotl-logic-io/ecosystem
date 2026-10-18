// One launch of a stage job, run as a child process: an ops request runs the
// installed ops.mjs with no model (src/job/ops-process.ts), and a model
// session runs `pi` in RPC mode (src/job/rpc.ts) as the launch's installed
// agent (src/job/agent-definition.ts), always fresh, with the write authority
// the launch itself carries. Either way the launch
// resolves to its raw result (src/job/raw-results.ts); it never rejects. The
// job's hooks hear of each launch's start, records and end. Nothing here
// limits a session's context or spend (`no-session-budgets`): the wall-clock
// timeout is the only bound.

import fs from "node:fs";
import path from "node:path";
import type { ModelRole } from "../config-legacy.ts";
import { head } from "../git-state.ts";
import { ROOT } from "../pipeline-root.ts";
import { piArgs, readDefinition } from "./agent-definition.ts";
import type { SessionEnd, Steers } from "./context-log.ts";
import type { LiveHandle } from "./control.ts";
import type { OpsProcess } from "./ops-process.ts";
import { runOps } from "./ops-process.ts";
import type { OpsRaw, SessionRaw } from "./raw-results.ts";
import { failedSession, opsRaw, sessionRaw } from "./raw-results.ts";
import type { SessionPhase } from "./role-context.ts";
import type { RpcAnswer, RpcCommand, RpcProcess } from "./rpc.ts";
import { runRpc } from "./rpc.ts";
import type { LaunchStart } from "./status.ts";

const OPS_CLI = path.join(ROOT, "ops.mjs");
const OUTPUT_EXTENSION = path.join(ROOT, "structured-output.mjs");
const COMMIT_EXTENSION = path.join(ROOT, "pipeline-commit.mjs");
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
  // Session `key` ended, after `ended`, as `end` says.
  sessionEnded: (key: string, end: SessionEnd) => void;
  // The whole environment launch `key`'s session runs with: a commit scope
  // only when the session `commits`, and never a token.
  env: (launch: {
    key: string;
    commits: boolean;
  }) => Readonly<Record<string, string>>;
  // Where every model session runs: the job's own folder.
  cwd: string;
  // The job's code checkout, in its folder.
  repo: string;
}

// One ops request: its key in job.json, its framed request and its timeout.
interface OpsLaunch {
  key: string;
  request: string;
  timeoutMs: number;
}

// One model session: its key, the model role it plays, its installed agent
// and model, its task, the JSON Schema of its reply, its timeout, whether it
// commits (its own write authority) and the reviewer phase it is labelled
// with (null for none).
interface SessionLaunch {
  key: string;
  role: ModelRole;
  agent: string;
  model: string;
  task: string;
  outputSchema: unknown;
  timeoutMs: number;
  commits: boolean;
  phase: SessionPhase | null;
}

// The code checkout's head, or null when it has none to read.
function checkoutHead(repo: string): string | null {
  try {
    return head(repo);
  } catch {
    return null;
  }
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

// `live` with the steers sent through it counted in `steers`.
function countingSteers(live: LiveHandle, steers: Steers): LiveHandle {
  if (live.kind !== "session") {
    return live;
  }
  const { session } = live;
  return {
    kind: "session",
    session: {
      ...session,
      send: (command: RpcCommand): Promise<RpcAnswer> => {
        if (command.type === "steer") {
          steers.socket += 1;
        }
        return session.send(command);
      },
    },
  };
}

// What tells the job that `launch`'s pi, writing `session`, started: its
// record names the session's write authority and phase, and its steers are
// counted in `steers`.
function spawnedOf(
  launch: SessionLaunch,
  session: string,
  watch: { hooks: LaunchHooks; steers: Steers },
): (rpc: RpcProcess) => void {
  const { key, commits, phase } = launch;
  return (rpc: RpcProcess): void => {
    const start: LaunchStart = {
      key,
      kind: "session",
      pid: rpc.pid,
      session,
      commits,
      phase,
    };
    const live: LiveHandle = { kind: "session", session: { key, ...rpc } };
    watch.hooks.started(start, countingSteers(live, watch.steers));
  };
}

// Runs `launch`'s session as its installed agent and resolves to its raw
// result. Only a launch that commits gets pipeline_commit, a commit scope and
// tools that edit or run commands; any other reads only, whatever its
// agent's definition lists (piArgs). The context log hears how it ended,
// with the head it ran on for a session that can't commit.
async function runSession(
  launch: SessionLaunch,
  hooks: LaunchHooks,
): Promise<SessionRaw> {
  const read = readDefinition(launch.agent);
  if (read.kind === "missing") {
    return failedSession(launch, read.error);
  }
  const files = prepareSession(launch, hooks);
  if (files === null) {
    const error = `agent ${launch.agent}: cannot prepare its session and schema files`;
    return failedSession(launch, error);
  }
  const { key, agent, model, role, commits } = launch;
  let commit: string | null = null;
  if (commits) {
    commit = COMMIT_EXTENSION;
  }
  const args = piArgs(read.definition, launch, {
    ...files,
    extension: OUTPUT_EXTENSION,
    commit,
  });
  let reviewedSha: string | null = null;
  if (!commits) {
    reviewedSha = checkoutHead(hooks.repo);
  }
  const steers: Steers = { socket: 0 };
  const exit = await runRpc({
    args,
    cwd: hooks.cwd,
    env: hooks.env({ key, commits }),
    prompt: launch.task,
    timeoutMs: launch.timeoutMs,
    onSpawn: spawnedOf(launch, files.session, { hooks, steers }),
    onRecord: (record: unknown): void => hooks.record(key, record),
  });
  hooks.ended(key);
  const raw = sessionRaw(launch, exit);
  let ended: SessionEnd["ended"] = "failed";
  if (raw.ok) {
    ended = "ok";
  }
  const headSha = checkoutHead(hooks.repo);
  hooks.sessionEnded(key, {
    role,
    agent,
    model,
    ended,
    steers,
    headSha,
    reviewedSha,
  });
  return raw;
}

// Runs ops request `launch` and resolves to its raw result.
async function runOpsLaunch(
  launch: OpsLaunch,
  hooks: LaunchHooks,
): Promise<OpsRaw> {
  const { key } = launch;
  const exit = await runOps({
    key,
    args: [OPS_CLI],
    input: launch.request,
    timeoutMs: launch.timeoutMs,
    started: (ops: OpsProcess): void => {
      const start: LaunchStart = {
        key,
        kind: "ops",
        pid: ops.pid,
        session: null,
      };
      hooks.started(start, { kind: "ops", ops });
    },
  });
  hooks.ended(key);
  return opsRaw(exit);
}

export type { LaunchHooks, OpsLaunch, SessionLaunch };
export { OUTPUT_EXTENSION, runOpsLaunch, runSession };
