// The shell supervisor, `node shell-supervisor.mjs <request JSON>`, which
// `shell` (process.ts) runs for each command (commands-leave-no-processes,
// #371). It runs the request's command as `bash -lc` in a process group and
// session of its own. The command ends when bash exits, when its time runs
// out, or when this process gets SIGTERM, SIGINT or SIGHUP, as it does when
// its op is stopped. Then every process left in the command's group gets
// SIGTERM and, after SHELL_KILL_GRACE_MS, SIGKILL. Once the group is empty,
// the supervisor stops reading any pipe a process outside it still holds,
// prints its report (shell-protocol.ts) as JSON on stdout and exits 0. A bad
// request exits 2 with the reason on stderr and no report. It ignores write
// errors on its outputs, since its parent may already be gone.

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import process from "node:process";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { childEnvironment } from "./child-env.ts";
import {
  endGroup,
  groupAlive,
  groupEnded,
  groupPids,
  within,
} from "./process-group.ts";
import type {
  ShellKilled,
  ShellReport,
  ShellRequest,
} from "./shell-protocol.ts";
import {
  SHELL_KILL_GRACE_MS,
  SHELL_OUTPUT_CAP,
  SHELL_REQUEST,
} from "./shell-protocol.ts";

const STOP_SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
const BAD_REQUEST_CODE = 2;

// One of the command's outputs: what it printed so far, up to
// SHELL_OUTPUT_CAP, and its end.
interface Output {
  text: () => string;
  ended: Promise<void>;
}

// How bash ended: its exit status, or the signal that ended it.
interface BashExit {
  status: number | null;
  signal: NodeJS.Signals | null;
}

// What ended the command.
type Ending = "exited" | "timedOut" | "stopped";

const NO_EXIT: BashExit = { status: null, signal: null };

function outputOf(stream: Readable): Output {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string): void => {
    if (text.length < SHELL_OUTPUT_CAP) {
      text += chunk;
    }
  });
  const ended = new Promise<void>((done: () => void): void => {
    stream.on("close", (): void => done());
  });
  return { text: (): string => text, ended };
}

// Resolves once bash exits, or with no status when it can't start, noting
// why in `errors`.
function exitOf(bash: ChildProcess, errors: string[]): Promise<BashExit> {
  return new Promise((done: (exit: BashExit) => void): void => {
    bash.on("exit", (status: number | null, signal: NodeJS.Signals | null) =>
      done({ status, signal }),
    );
    bash.on("error", (error: Error): void => {
      errors.push(`bash: ${error.message}\n`);
      done(NO_EXIT);
    });
  });
}

// What ends the command first: bash's exit, its time limit or a stop.
async function endingOf(
  exit: Promise<BashExit>,
  stopped: Promise<void>,
  timeoutMs: number,
): Promise<Ending> {
  let timer: NodeJS.Timeout | undefined;
  const timeUp = new Promise<Ending>((end: (ending: Ending) => void): void => {
    timer = setTimeout((): void => end("timedOut"), timeoutMs);
  });
  const ending = await Promise.race([
    exit.then((): "exited" => "exited"),
    stopped.then((): "stopped" => "stopped"),
    timeUp,
  ]);
  clearTimeout(timer);
  return ending;
}

// Ends what is left in the group `pgid` leads, and waits for it to be
// empty; null when nothing was left.
async function killLeft(pgid: number | undefined): Promise<ShellKilled | null> {
  if (pgid === undefined || !groupAlive(pgid)) {
    return null;
  }
  const pids = groupPids(pgid);
  const grace = SHELL_KILL_GRACE_MS;
  const signals = await endGroup(pgid, groupEnded(pgid, grace), grace);
  if (signals.at(-1) === "SIGKILL") {
    await within(groupEnded(pgid, grace), grace);
  }
  return { pgid, pids, signals };
}

async function supervise(
  request: ShellRequest,
  stopped: Promise<void>,
): Promise<ShellReport> {
  const errors: string[] = [];
  const bash = spawn("bash", ["-lc", request.command], {
    detached: true,
    env: childEnvironment(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = outputOf(bash.stdout);
  const stderr = outputOf(bash.stderr);
  const exit = exitOf(bash, errors);
  const ending = await endingOf(exit, stopped, request.timeoutMs);
  const killed = await killLeft(bash.pid);
  const grace = SHELL_KILL_GRACE_MS;
  const { status, signal } = await Promise.race([exit, delay(grace, NO_EXIT)]);
  await within(Promise.all([stdout.ended, stderr.ended]), grace);
  bash.stdout.destroy();
  bash.stderr.destroy();
  return {
    stdout: stdout.text(),
    stderr: `${stderr.text()}${errors.join("")}`,
    status,
    signal,
    timedOut: ending === "timedOut",
    killed,
  };
}

// The request in this process's argument, or why it isn't one.
function requestOf(arg: string | undefined): ShellRequest | string {
  let request: unknown = null;
  try {
    request = JSON.parse(arg ?? "");
  } catch {
    return "the request is not JSON";
  }
  const parsed = SHELL_REQUEST.safeParse(request);
  if (!parsed.success) {
    return z.prettifyError(parsed.error);
  }
  return parsed.data;
}

function ignoreWriteError(): void {
  // The parent may be gone: what it would have read no longer matters.
}

async function main(): Promise<void> {
  process.stdout.on("error", ignoreWriteError);
  process.stderr.on("error", ignoreWriteError);
  const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
  for (const name of STOP_SIGNALS) {
    process.on(name, (): void => stop());
  }
  const [, , arg] = process.argv;
  const request = requestOf(arg);
  if (typeof request === "string") {
    process.stderr.write(`shell-supervisor: bad request: ${request}\n`);
    process.exitCode = BAD_REQUEST_CODE;
    return;
  }
  const report = await supervise(request, stopped);
  process.stdout.write(JSON.stringify(report), (): never => process.exit(0));
}

await main();
