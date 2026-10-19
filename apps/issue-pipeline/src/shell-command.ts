// Configured shell commands, synchronous for deterministic ops and asynchronous
// for stage-job checkout preparation. Both use the same supervised execution,
// environment boundary and log/result contract; owners can stop async commands.
import type { SpawnSyncReturns } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { childEnvironment } from "./child-env.ts";
import { endGroup } from "./process-group.ts";
import type { ShellKilled, ShellReport } from "./shell-protocol.ts";
import { SHELL_KILL_GRACE_MS, SHELL_REPORT } from "./shell-protocol.ts";

interface ShellOptions {
  timeoutMs: number;
  env: ReadonlyMap<string, string>;
}

interface ShellProcess {
  pid: number | null;
  exited: Promise<void>;
}

interface AsyncShellOptions extends ShellOptions {
  started: (child: ShellProcess) => void;
}

interface ShellResult {
  code: number;
  log: string | undefined;
  tail: string;
}

const MAX_BUFFER_BYTES = 268_435_456; // 256 MiB
const TIMED_OUT_CODE: number = 124;
const SHELL_TAIL_LINES = 25;
// The shell supervisor, built (beside ops.mjs) or as source.
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

const SHELL_ENV: ReadonlyMap<string, string> = new Map([["CI", "1"]]);

function environment(added: ReadonlyMap<string, string>): NodeJS.ProcessEnv {
  return {
    ...childEnvironment(process.env),
    ...Object.fromEntries(new Map([...added, ...SHELL_ENV])),
  };
}

// The first of the shell supervisor's files that exists beside this module:
// the built one beside ops.mjs, else the source, which Node runs by
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
  options: ShellOptions,
): ShellReport {
  const { timeoutMs, env } = options;
  const request = JSON.stringify({ command, timeoutMs });
  const result = spawnSync(process.execPath, [file, request], {
    cwd,
    encoding: "utf8",
    env: environment(env),
    killSignal: "SIGTERM",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: timeoutMs + SUPERVISOR_SLACK_MS,
  });
  return reportOf(result);
}

// The supervisor's report, or, when it gave none it could parse, how the
// supervisor itself ended, with its stderr.
function reportOf(
  result: Pick<
    SpawnSyncReturns<string>,
    "stdout" | "stderr" | "status" | "signal"
  > & { error?: Error | undefined },
): ShellReport {
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
  // A supervisor exit code is not a command result. No valid report means
  // execution was not established, even if the supervisor itself exited 0.
  return {
    stdout: "",
    stderr,
    status: null,
    signal: result.signal,
    timedOut: false,
    killed: null,
  };
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
// (commands-leave-no-processes, #371). Writes everything it printed to
// `logPath`, if given, and never throws: a command that timed out, ended by
// a signal, or never ran because the supervisor is missing, gives
// TIMED_OUT_CODE.
function shell(
  command: string,
  cwd: string,
  logPath: string | undefined,
  timeout: number | ShellOptions,
): ShellResult {
  let options: ShellOptions;
  if (typeof timeout === "number") {
    options = { timeoutMs: timeout, env: new Map() };
  } else {
    options = timeout;
  }
  const file = supervisorFile();
  let report = missingSupervisor();
  if (file !== undefined) {
    report = supervised(file, command, cwd, options);
  }
  return shellResult(command, logPath, report);
}

// The same supervised command contract without blocking a stage job's
// control socket or signal handlers. The owner registers the supervisor for
// cancellation; its signal handler cleans the command's separate group.
async function asyncShell(
  command: string,
  cwd: string,
  logPath: string | undefined,
  options: AsyncShellOptions,
): Promise<ShellResult> {
  const file = supervisorFile();
  if (file === undefined) {
    return shellResult(command, logPath, missingSupervisor());
  }
  const { timeoutMs, env } = options;
  const request = JSON.stringify({ command, timeoutMs });
  const child = spawn(process.execPath, [file, request], {
    cwd,
    detached: true,
    env: environment(env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let error: Error | undefined;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string): void => {
    if (stdout.length < MAX_BUFFER_BYTES) {
      stdout += chunk;
    }
  });
  child.stderr.on("data", (chunk: string): void => {
    if (stderr.length < MAX_BUFFER_BYTES) {
      stderr += chunk;
    }
  });
  child.on("error", (caught: Error): void => {
    error = caught;
  });
  const closed = new Promise<ShellReport>(
    (resolve: (report: ShellReport) => void): void => {
      child.on(
        "close",
        (status: number | null, signal: NodeJS.Signals | null): void => {
          resolve(reportOf({ stdout, stderr, status, signal, error }));
        },
      );
    },
  );
  const exited = closed.then((): void => undefined);
  const pid = child.pid ?? null;
  options.started({ pid, exited });
  const timer = setTimeout((): void => {
    if (pid !== null) {
      endGroup(pid, exited, SHELL_KILL_GRACE_MS).catch(() => null);
    }
  }, timeoutMs + SUPERVISOR_SLACK_MS);
  try {
    return shellResult(command, logPath, await closed);
  } finally {
    clearTimeout(timer);
  }
}

function shellResult(
  command: string,
  logPath: string | undefined,
  report: ShellReport,
): ShellResult {
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

export type { ShellProcess, ShellResult };
export { asyncShell, shell, tail };
