// Runs commands for the ops CLI. `run` executes one program with arguments and
// throws an OpsError naming it when it fails; `shell` runs a configured
// command line through bash, in a process group the shell supervisor
// (shell-supervisor.ts) empties when it ends, logs everything it printed and
// never throws.
// `parseRequest` reads an op's request, throwing an OpsError when it is
// malformed.

import type { SpawnSyncReturns } from "node:child_process";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { childEnvironment } from "@ecosystem/task-runtime/child-env";
import { OpsError } from "@ecosystem/task-runtime/ops-error";
import { z } from "zod";
import { ROOT } from "./host-paths.ts";
import type { ShellKilled, ShellReport } from "./shell-protocol.ts";
import { SHELL_KILL_GRACE_MS, SHELL_REPORT } from "./shell-protocol.ts";

interface RunOptions {
  allowFail?: boolean;
  cwd?: string;
  // Variables added to this process's environment, by name.
  env?: ReadonlyMap<string, string>;
  input?: string;
  timeoutMs?: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ShellOptions {
  timeoutMs: number;
  env?: ReadonlyMap<string, string>;
}

interface ShellResult {
  code: number;
  log: string | undefined;
  tail: string;
}

const MAX_BUFFER_BYTES = 268_435_456; // 256 MiB
const TIMED_OUT_CODE: number = 124;
const MS_PER_SECOND = 1000;
const FAILURE_LINES = 15;
const SHELL_TAIL_LINES = 25;
const TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9_]+/gu;
// The shell supervisor, built (beside the task apps) or as source.
const SUPERVISOR_FILES: readonly string[] = [
  "shell-supervisor.mjs",
  "shell-supervisor.ts",
];
// How long past a command's own time limit `shell` waits for its supervisor
// before stopping it: the supervisor's three graces (SIGTERM, SIGKILL, the
// pipes), plus time for Node to start.
const SUPERVISOR_GRACES = 3;
const SUPERVISOR_STARTUP_MS = 10_000;
const SUPERVISOR_SLACK_MS: number =
  SUPERVISOR_GRACES * SHELL_KILL_GRACE_MS + SUPERVISOR_STARTUP_MS;

// The last `count` lines of `text`, without trailing blank space.
function tail(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-count).join("\n");
}

// What a failed command says about itself, with any GitHub token hidden.
function runFailure(
  cmd: string,
  args: readonly string[],
  out: RunResult,
  options: RunOptions = {},
): string {
  const shown = [cmd, ...args].join(" ").replace(TOKEN_PATTERN, "<token>");
  const output = tail(out.stderr || out.stdout, FAILURE_LINES);
  if (out.timedOut) {
    const seconds = Math.round((options.timeoutMs ?? 0) / MS_PER_SECOND);
    return `${shown} timed out after ${seconds}s: ${output}`;
  }
  return `${shown} exited ${out.code}: ${output}`;
}

// A process that exited by signal reports no status; one killed by its
// timeout counts as timed out.
function failedCode(signal: NodeJS.Signals | null): number {
  if (signal === null) {
    return 1;
  }
  return TIMED_OUT_CODE;
}

const SHELL_ENV: ReadonlyMap<string, string> = new Map([["CI", "1"]]);

function environment(
  added: ReadonlyMap<string, string> | undefined,
): NodeJS.ProcessEnv {
  return {
    ...childEnvironment(process.env),
    ...Object.fromEntries(added ?? new Map()),
  };
}

function run(
  cmd: string,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: environment(options.env),
    input: options.input,
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: options.timeoutMs,
  });
  const { error } = result;
  const timedOut =
    error !== undefined && "code" in error && error.code === "ETIMEDOUT";
  const out: RunResult = {
    code: result.status ?? failedCode(result.signal),
    stderr: result.stderr || "",
    stdout: result.stdout || "",
    timedOut,
  };
  if (options.allowFail !== true && out.code !== 0) {
    throw new OpsError(runFailure(cmd, args, out, options));
  }
  return out;
}

// The first of the shell supervisor's files that exists beside this module:
// the built one beside the task apps, else the source, which Node runs by
// stripping its types. Undefined when neither does.
function supervisorFile(): string | undefined {
  const files = SUPERVISOR_FILES.map((name: string): string =>
    path.join(import.meta.dirname, name),
  );
  return files.find((file: string): boolean => fs.existsSync(file));
}

// The report for a command that never ran because the supervisor is
// missing: no status, so `shell` gives TIMED_OUT_CODE, never success.
function missingSupervisor(): ShellReport {
  const files = SUPERVISOR_FILES.join(" or ");
  const stderr = `shell: no shell supervisor (${files}) in ${import.meta.dirname}, so the command didn't run\n`;
  return {
    stdout: "",
    stderr,
    status: null,
    signal: null,
    timedOut: false,
    killed: null,
  };
}

// Runs the command through the supervisor in `file` and reads its report.
function supervised(
  file: string,
  command: string,
  cwd: string,
  { timeoutMs, env = new Map() }: ShellOptions,
): ShellReport {
  const request = JSON.stringify({ command, timeoutMs });
  const result = spawnSync(process.execPath, [file, request], {
    cwd,
    encoding: "utf8",
    env: environment(new Map([...SHELL_ENV, ...env])),
    killSignal: "SIGTERM",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: timeoutMs + SUPERVISOR_SLACK_MS,
  });
  return reportOf(result);
}

// The supervisor's report, or, when it gave none it could parse, how the
// supervisor itself ended, with its stderr.
function reportOf(result: SpawnSyncReturns<string>): ShellReport {
  const stdout = result.stdout || "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const report = SHELL_REPORT.safeParse(parsed);
  if (report.success) {
    return report.data;
  }
  const stderr = `${result.stderr || ""}${result.error?.message ?? ""}\nshell: the shell supervisor gave no report\n`;
  const { status, signal } = result;
  return { stdout: "", stderr, status, signal, timedOut: false, killed: null };
}

// The log's last line when anything was left in the command's group.
function killedLine(killed: ShellKilled | null): string {
  if (killed === null) {
    return "";
  }
  let pids = "pids unknown";
  if (killed.pids !== null) {
    pids = `pids ${killed.pids.join(", ")}`;
  }
  const signals = killed.signals.join(", then ");
  return `--- killed process group ${killed.pgid} (${pids}): ${signals} ---\n`;
}

// Runs `command` with `bash -lc` in `cwd`, within `timeoutMs`, through the
// shell supervisor, which ends every process the command left in its group
// (#371). Writes everything it printed to `logPath`, if given, and never
// throws: a command that timed out, ended by a signal, or never ran because
// the supervisor is missing, gives TIMED_OUT_CODE.
function shell(
  command: string,
  cwd: string,
  logPath: string | undefined,
  options: number | ShellOptions,
): ShellResult {
  let settings: ShellOptions;
  if (typeof options === "number") {
    settings = { timeoutMs: options };
  } else {
    settings = options;
  }
  const file = supervisorFile();
  let report = missingSupervisor();
  if (file !== undefined) {
    report = supervised(file, command, cwd, settings);
  }
  const { stdout, stderr } = report;
  const exit = report.status ?? report.signal;
  const text = `$ ${command}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n--- exit ${exit} ---\n${killedLine(report.killed)}`;
  if (logPath !== undefined && logPath !== "") {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, text);
  }
  let code = report.status ?? TIMED_OUT_CODE;
  if (report.timedOut) {
    code = TIMED_OUT_CODE;
  }
  return {
    code,
    log: logPath,
    tail: tail(`${stdout}\n${stderr}`, SHELL_TAIL_LINES),
  };
}

// The value `schema` parses from an op's `request`, or an OpsError naming the
// op and what is wrong with the request.
function parseRequest<T>(
  schema: z.ZodType<T>,
  op: string,
  request: unknown,
): T {
  const result = schema.safeParse(request);
  if (!result.success) {
    throw new OpsError(`bad ${op} request: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export type { RunOptions, RunResult, ShellResult };
export { parseRequest, run, runFailure, shell, tail };
