// One launch of the sweep, run as a child process by the stage job: an ops
// request runs the installed ops.mjs with no model, and a model session runs
// `pi` in RPC mode (src/job/rpc.ts) as the launch's installed agent, fresh or
// resuming an interrupted session. Either way the launch resolves to the raw
// result the sweep's driver reads; it never rejects. The job's hooks hear of
// each launch's start, its records and its end.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ROOT } from "../pipeline-root.ts";
import type { ChildSpec, LaunchSpec } from "../workflow/launches.ts";
import { piArgs, readDefinition } from "./agent-definition.ts";
import type { LiveLaunch } from "./control.ts";
import type { OpsRaw, ProcessExit, SessionRaw } from "./raw-results.ts";
import {
  failedSession,
  opsRaw,
  sessionRaw,
  ZERO_USAGE,
} from "./raw-results.ts";
import type { RpcProcess } from "./rpc.ts";
import { runRpc } from "./rpc.ts";
import type { LaunchStart, ResumePoint } from "./status.ts";

const OPS_CLI = path.join(ROOT, "ops.mjs");
const OUTPUT_EXTENSION = path.join(ROOT, "structured-output.mjs");
const TIME_RADIX = 36;
// The prompt that carries on an interrupted session.
const RESUME_PROMPT =
  "This session was interrupted before it finished. Carry on with your task from where it stopped, and end with the structured_output tool as your task says.";

// What the stage job hears of its launches.
interface LaunchHooks {
  // Where launch `key`'s session JSONL goes when it starts fresh.
  sessionFile: (key: string) => string;
  // Where an interrupted session of launch `key` can carry on, if anywhere.
  resumePoint: (key: string) => ResumePoint | null;
  // A launch started; `live` is its pi session, or null for an ops child.
  started: (launch: LaunchStart, live: LiveLaunch | null) => void;
  // Session `key` printed `record`.
  record: (key: string, record: unknown) => void;
  // Launch `key`'s process ended.
  ended: (key: string) => void;
  // The whole environment a session of installed agent `agent` runs with.
  env: (agent: string) => Readonly<Record<string, string>>;
  // Where every model session runs: the job's own checkout.
  cwd: string;
}

// An ops command to run: its arguments, stdin and time limit, and the hook
// told its pid once it starts.
interface Command {
  args: readonly string[];
  input: string;
  timeoutMs: number;
  started: (pid: number | null) => void;
}

// Runs ops.mjs, writing its input to stdin, and stops it with SIGTERM once
// its time is up. A command that can't start ends with code null and the
// reason on stderr.
function runCommand(command: Command): Promise<ProcessExit> {
  const { args, input, timeoutMs } = command;
  const program = process.execPath;
  return new Promise((resolve: (exit: ProcessExit) => void): void => {
    const exit: ProcessExit = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
    const child = spawn(program, args, { stdio: "pipe", detached: true });
    command.started(child.pid ?? null);
    const timer = setTimeout((): void => {
      exit.timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    function noteError(error: Error): void {
      exit.stderr += `${program}: ${error.message}\n`;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string): void => {
      exit.stdout += chunk;
    });
    child.stderr.on("data", (chunk: string): void => {
      exit.stderr += chunk;
    });
    child.stdin.on("error", noteError);
    child.on("error", noteError);
    child.on("close", (code: number | null): void => {
      clearTimeout(timer);
      resolve({ ...exit, code });
    });
    child.stdin.end(input);
  });
}

// Readies the launch's files: creates the sessions folder, moves an earlier
// job's session at the same path aside to `<key>.<time>.jsonl` unless it is
// being resumed (pi would otherwise resume it, since launch keys repeat from
// job to job), and writes the output schema beside it. Returns the schema
// file, or null if any of that fails.
function prepareFiles(
  spec: ChildSpec,
  sessionFile: string,
  resuming: boolean,
): string | null {
  const dir = path.dirname(sessionFile);
  const schema = path.join(dir, `${spec.key}.schema.json`);
  const aside = path.join(
    dir,
    `${spec.key}.${Date.now().toString(TIME_RADIX)}.jsonl`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!resuming && fs.existsSync(sessionFile)) {
      fs.renameSync(sessionFile, aside);
    }
    fs.writeFileSync(schema, JSON.stringify(spec.outputSchema));
    return schema;
  } catch {
    return null;
  }
}

async function runSession(
  spec: ChildSpec,
  hooks: LaunchHooks,
): Promise<SessionRaw> {
  const read = readDefinition(spec.agent);
  if (read.kind === "missing") {
    return failedSession(spec, read.error);
  }
  const resume = hooks.resumePoint(spec.key);
  const session = resume?.session ?? hooks.sessionFile(spec.key);
  const schema = prepareFiles(spec, session, resume !== null);
  if (schema === null) {
    return failedSession(
      spec,
      `agent ${spec.agent}: cannot prepare its session and schema files`,
    );
  }
  const files = { session, extension: OUTPUT_EXTENSION, schema };
  const { key } = spec;
  const usage = resume?.usage ?? ZERO_USAGE;
  let prompt = spec.task;
  if (resume !== null) {
    prompt = RESUME_PROMPT;
  }
  const exit = await runRpc({
    args: piArgs(read.definition, spec, files),
    cwd: hooks.cwd,
    env: hooks.env(spec.agent),
    prompt,
    timeoutMs: spec.timeoutMs,
    onSpawn: (rpc: RpcProcess): void => {
      const { pid } = rpc;
      const resumed = resume !== null;
      const start: LaunchStart = {
        key,
        kind: "session",
        pid,
        session,
        resumed,
        usage,
      };
      hooks.started(start, { key, ...rpc });
    },
    onRecord: (record: unknown): void => hooks.record(key, record),
  });
  hooks.ended(key);
  return sessionRaw(spec, exit, usage);
}

// Runs `spec` and resolves to its raw result, telling `hooks` of it. A model
// session resumes where `hooks.resumePoint` says, and otherwise starts fresh
// with its JSONL at `hooks.sessionFile(spec.key)`.
async function runLaunch(
  spec: LaunchSpec,
  hooks: LaunchHooks,
): Promise<OpsRaw | SessionRaw> {
  if ("model" in spec) {
    return await runSession(spec, hooks);
  }
  const { key } = spec;
  const exit = await runCommand({
    args: [OPS_CLI],
    input: spec.task,
    timeoutMs: spec.timeoutMs,
    started: (pid: number | null): void => {
      const start: LaunchStart = {
        key,
        kind: "ops",
        pid,
        session: null,
        resumed: false,
        usage: ZERO_USAGE,
      };
      hooks.started(start, null);
    },
  });
  hooks.ended(key);
  return opsRaw(exit);
}

export type { LaunchHooks };
export { runLaunch };
