// One launch of the sweep, run as a child process by the stage job: an ops
// request runs the installed ops.mjs with no model, and a model session runs
// `pi` in JSON mode as the launch's installed agent. Either way the launch
// resolves to the raw result the sweep's driver reads; it never rejects.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ROOT } from "../pipeline-root.ts";
import type { ChildSpec, LaunchSpec } from "../workflow/launches.ts";
import { piArgs, readDefinition } from "./agent-definition.ts";
import type { OpsRaw, ProcessExit, SessionRaw } from "./raw-results.ts";
import { failedSession, opsRaw, sessionRaw } from "./raw-results.ts";

const OPS_CLI = path.join(ROOT, "ops.mjs");
const OUTPUT_EXTENSION = path.join(ROOT, "structured-output.mjs");
const PI = "pi";
const TIME_RADIX = 36;

// A command to run: its program, arguments, folder, stdin and time limit.
interface Command {
  program: string;
  args: readonly string[];
  cwd: string;
  input: string;
  timeoutMs: number;
}

// Runs the command, writing its input to stdin, and stops it with SIGTERM
// once its time is up. A command that can't start ends with code null and
// the reason on stderr.
function runCommand(command: Command): Promise<ProcessExit> {
  const { program, args, cwd, input, timeoutMs } = command;
  return new Promise((resolve: (exit: ProcessExit) => void): void => {
    const exit: ProcessExit = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
    const child = spawn(program, args, { cwd, stdio: "pipe" });
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
// job's session at the same path aside to `<key>.<time>.jsonl` (pi would
// otherwise resume it, since launch keys repeat from job to job), and writes
// the output schema beside it. Returns the schema file, or null if any of
// that fails.
function prepareFiles(spec: ChildSpec, sessionFile: string): string | null {
  const dir = path.dirname(sessionFile);
  const schema = path.join(dir, `${spec.key}.schema.json`);
  const aside = path.join(
    dir,
    `${spec.key}.${Date.now().toString(TIME_RADIX)}.jsonl`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(sessionFile)) {
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
  sessionFile: string,
): Promise<SessionRaw> {
  const read = readDefinition(spec.agent);
  if (read.kind === "missing") {
    return failedSession(spec, read.error);
  }
  const schema = prepareFiles(spec, sessionFile);
  if (schema === null) {
    return failedSession(
      spec,
      `agent ${spec.agent}: cannot prepare its session and schema files`,
    );
  }
  const files = { session: sessionFile, extension: OUTPUT_EXTENSION, schema };
  const exit = await runCommand({
    program: PI,
    args: piArgs(read.definition, spec, files),
    cwd: spec.cwd,
    input: spec.task,
    timeoutMs: spec.timeoutMs,
  });
  return sessionRaw(spec, exit);
}

// Runs `spec` and resolves to its raw result. A model session's JSONL goes
// to `sessionFile(spec.key)`, always in a fresh session.
async function runLaunch(
  spec: LaunchSpec,
  sessionFile: (key: string) => string,
): Promise<OpsRaw | SessionRaw> {
  if ("model" in spec) {
    return await runSession(spec, sessionFile(spec.key));
  }
  const exit = await runCommand({
    program: process.execPath,
    args: [OPS_CLI],
    cwd: process.cwd(),
    input: spec.task,
    timeoutMs: spec.timeoutMs,
  });
  return opsRaw(exit);
}

export { runLaunch };
