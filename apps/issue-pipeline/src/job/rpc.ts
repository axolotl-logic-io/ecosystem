// One `pi --mode rpc` process run to its end: it sends the prompt only
// after optional native-policy verification, reads LF-framed JSON, correlates
// responses to the commands it sent, and closes stdin, which shuts pi down,
// once the run has settled or pi refused the prompt. While it runs, the
// caller holds a handle that sends commands (abort, steer) and kills it.
// pi starts in a process group of its own, and a kill or a timeout ends the
// whole group, so the tools pi started end with it
// (commands-leave-no-processes, #371).

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { childEnvironment } from "../child-env.ts";
import { endGroup, signalGroup } from "../process-group.ts";
import { STOP_GRACE_MS } from "./control.ts";
import type { ProcessExit } from "./raw-results.ts";
import {
  endsSession,
  framerOf,
  isProbeRecord,
  probeRefusal,
  RESPONSE,
  recordOf,
  SETTLED,
} from "./rpc-protocol.ts";
import type { NativePolicy } from "./runtime-policy.ts";

const PI = "pi";
const PROMPT_ID = "prompt";
const PREFLIGHT_ID = "runtime-policy";
const ENDED: RpcAnswer = { success: false, error: "the session has ended" };
// The commands a live session takes besides its prompt.
type RpcCommand = { type: "abort" } | { type: "steer"; message: string };

// pi's answer to a command: whether it accepted it, and why not.
interface RpcAnswer {
  success: boolean;
  error: string | null;
}

// A running pi process.
interface RpcProcess {
  pid: number | null;
  // Sends `command` and resolves to pi's answer; to a failure once pi ended.
  send: (command: RpcCommand) => Promise<RpcAnswer>;
  // Signals pi's process group unless pi has already exited.
  kill: (signal: NodeJS.Signals) => void;
  // Resolves once pi has exited.
  exited: Promise<void>;
}

// What to run: pi's arguments, its folder, its whole environment, the
// prompt, the time limit, and the hooks told of the process and of each
// record it prints.
interface RpcRun {
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  prompt: string;
  timeoutMs: number;
  onSpawn: (rpc: RpcProcess) => void;
  onRecord: (record: unknown) => void;
  preflight?: {
    policy: NativePolicy;
    endpoint: string;
    provenance: Readonly<Record<string, string>>;
    verify: () => string | null;
  };
}

// The commands sent to one pi, by id, until pi answers each.
interface Channel {
  send: (command: Record<string, unknown>) => Promise<RpcAnswer>;
  answer: (id: string, answer: RpcAnswer) => void;
  // Answers every unanswered command with a failure.
  endAll: () => void;
}

function channelOf(stdin: Writable): Channel {
  const pending = new Map<string, (answer: RpcAnswer) => void>();
  let sent = 0;
  return {
    send: (command: Record<string, unknown>): Promise<RpcAnswer> => {
      if (stdin.writableEnded) {
        return Promise.resolve(ENDED);
      }
      sent += 1;
      const id = `c${sent}`;
      return new Promise((answer: (a: RpcAnswer) => void): void => {
        pending.set(id, answer);
        stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      });
    },
    answer: (id: string, answer: RpcAnswer): void => {
      pending.get(id)?.(answer);
      pending.delete(id);
    },
    endAll: (): void => {
      for (const answer of pending.values()) {
        answer(ENDED);
      }
      pending.clear();
    },
  };
}

// Reads one record pi printed: answers the command it responds to, and
// closes stdin once the run has settled or pi refused the prompt.
function readRecord(record: unknown, stdin: Writable, channel: Channel): void {
  if (SETTLED.safeParse(record).success) {
    stdin.end();
  }
  const response = RESPONSE.safeParse(record);
  if (!response.success) {
    return;
  }
  const { id, success, error } = response.data;
  if (endsSession(id, record)) {
    stdin.end();
  }
  channel.answer(id, { success, error: error ?? null });
}

function handleOf(
  child: ChildProcessWithoutNullStreams,
  channel: Channel,
  exited: Promise<void>,
  ready: () => boolean,
): RpcProcess {
  const pid = child.pid ?? null;
  return {
    pid,
    send: (command: RpcCommand): Promise<RpcAnswer> => {
      if (!ready() && command.type === "steer") {
        return Promise.resolve({
          success: false,
          error: "runtime policy not verified",
        });
      }
      return channel.send(command);
    },
    kill: (signal: NodeJS.Signals): void => {
      const running = child.exitCode === null && child.signalCode === null;
      if (running && pid !== null) {
        signalGroup(pid, signal);
      }
    },
    exited,
  };
}

function sendPrompt(stdin: Writable, message: string): void {
  stdin.write(
    `${JSON.stringify({ id: PROMPT_ID, type: "prompt", message })}\n`,
  );
}

function beginPrompt(
  record: unknown,
  run: RpcRun,
  exit: ProcessExit,
  stdin: Writable,
): boolean {
  const { preflight } = run;
  let refusal: string | null = probeRefusal(record, preflight);
  if (refusal === null && preflight !== undefined) {
    refusal = preflight.verify();
  }
  if (refusal !== null) {
    exit.code = 1;
    exit.stderr += `${refusal}\n`;
    stdin.end();
    return false;
  }
  // Never log the complete native Model: providers can put private
  // headers in it. This diagnostic contains only our validated policy.
  const safe = {
    type: "runtime_policy",
    ...preflight?.policy,
    ...preflight?.provenance,
  };
  exit.stdout += `${JSON.stringify(safe)}\n`;
  run.onRecord(safe);
  sendPrompt(stdin, run.prompt);
  return true;
}

function recordsOf(
  run: RpcRun,
  exit: ProcessExit,
  stdin: Writable,
  channel: Channel,
): {
  framer: ReturnType<typeof framerOf>;
  start: () => void;
  ready: () => boolean;
} {
  let probing = run.preflight !== undefined;
  let ready = !probing;
  const framer = framerOf((line: string): void => {
    const record = recordOf(line);
    if (run.preflight !== undefined && isProbeRecord(record)) {
      if (probing) {
        probing = false;
        ready = beginPrompt(record, run, exit, stdin);
      }
      return;
    }
    if (probing) {
      return;
    }
    exit.stdout += `${line}\n`;
    if (record !== null) {
      run.onRecord(record);
      readRecord(record, stdin, channel);
    }
  });
  return {
    framer,
    ready: (): boolean => ready,
    start: (): void => {
      if (probing) {
        stdin.write(
          `${JSON.stringify({ id: PREFLIGHT_ID, type: "get_state" })}\n`,
        );
      } else {
        sendPrompt(stdin, run.prompt);
      }
    },
  };
}

// Runs pi as `run` says and resolves to how it ended, with every record it
// printed as stdout. A pi that can't start ends with code null and the
// reason on stderr. It never rejects.
function runRpc(run: RpcRun): Promise<ProcessExit> {
  return new Promise((resolve: (exit: ProcessExit) => void): void => {
    const exit: ProcessExit = {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
    const child = spawn(PI, [...run.args], {
      cwd: run.cwd,
      env: childEnvironment(run.env),
      stdio: "pipe",
      detached: true,
    });
    const pid = child.pid ?? null;
    const exited = new Promise<void>((done: () => void): void => {
      child.on("close", (): void => done());
    });
    const channel = channelOf(child.stdin);
    const records = recordsOf(run, exit, child.stdin, channel);
    const timer = setTimeout((): void => {
      exit.timedOut = true;
      if (pid !== null) {
        endGroup(pid, exited, STOP_GRACE_MS).catch(() => null);
      }
    }, run.timeoutMs);
    function noteError(error: Error): void {
      exit.stderr += `${PI}: ${error.message}\n`;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", records.framer.push);
    child.stderr.on("data", (chunk: string): void => {
      exit.stderr += chunk;
    });
    child.stdin.on("error", noteError);
    child.on("error", noteError);
    child.on("close", (code: number | null): void => {
      clearTimeout(timer);
      records.framer.flush();
      channel.endAll();
      if (run.preflight !== undefined && !records.ready()) {
        exit.code = 1;
        exit.stderr +=
          "runtime: native RPC policy was not verified before process exit\n";
      }
      if (exit.code !== null) {
        resolve(exit);
        return;
      }
      resolve({ ...exit, code });
    });
    run.onSpawn(handleOf(child, channel, exited, records.ready));
    records.start();
  });
}

export type { RpcAnswer, RpcCommand, RpcProcess };
export { runRpc };
