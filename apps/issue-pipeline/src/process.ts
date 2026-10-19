// Runs commands for the ops CLI. `run` executes one program with arguments and
// throws an OpsError naming it when it fails. Configured shell commands
// live in shell-command.ts.
// `parseRequest` reads an op's request, throwing an OpsError when it is
// malformed.

import { spawnSync } from "node:child_process";
import process from "node:process";
import { z } from "zod";
import { childEnvironment } from "./child-env.ts";
import { OpsError } from "./ops-error.ts";
import { ROOT } from "./pipeline-root.ts";
import { tail } from "./shell-command.ts";

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

const MAX_BUFFER_BYTES = 268_435_456; // 256 MiB
const TIMED_OUT_CODE: number = 124;
const MS_PER_SECOND = 1000;
const FAILURE_LINES = 15;
const TOKEN_PATTERN = /gh[pousr]_[A-Za-z0-9_]+/gu;

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

// Blocks the whole process: the ops CLI runs one request and has nothing else
// to do while it waits.
function sleepMs(ms: number): void {
  const cell = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  Atomics.wait(cell, 0, 0, ms);
}

export type { RunOptions, RunResult };
export { parseRequest, run, runFailure, sleepMs };
