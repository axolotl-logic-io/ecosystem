import { spawnSync } from "node:child_process";
import process from "node:process";
import { childEnvironment } from "./child-env.ts";
import { OpsError } from "./ops-error.ts";

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

const MAX_BUFFER_BYTES = 268_435_456;
const TIMED_OUT_CODE: number = 124;
const MS_PER_SECOND = 1000;
const FAILURE_LINES = 15;
const TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9_]+/gu;
function tail(text: string, count: number): string {
  const lines = text.trimEnd().split("\n");
  return lines.slice(-count).join("\n");
}

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

function failedCode(signal: NodeJS.Signals | null): number {
  if (signal === null) {
    return 1;
  }
  return TIMED_OUT_CODE;
}

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
    cwd: options.cwd,
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

export type { RunOptions, RunResult };
export { run, runFailure, tail };
