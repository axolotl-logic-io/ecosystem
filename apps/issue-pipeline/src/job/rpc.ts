// One `pi --mode rpc` process run to its end: it sends the prompt as the
// first command, reads stdout as LF-framed JSON records, correlates the
// responses to the commands it sent, and closes stdin, which shuts pi down,
// once the run has settled or pi refused the prompt. While it runs, the
// caller holds a handle that sends commands (abort, steer) and kills it.

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { Writable } from "node:stream";
import { z } from "zod";
import type { ProcessExit } from "./raw-results.ts";

const PI = "pi";
const PROMPT_ID = "prompt";
const TRAILING_CR = /\r$/u;
const ENDED: RpcAnswer = { success: false, error: "the session has ended" };
const RESPONSE = z.object({
  type: z.literal("response"),
  id: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});
// A prompt pi handled without starting a run, so no agent_settled follows.
const HANDLED = z.object({
  data: z.object({ disposition: z.literal("handled") }),
});
const SETTLED = z.object({ type: z.literal("agent_settled") });

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
  // Signals pi unless it has already exited.
  kill: (signal: NodeJS.Signals) => void;
  // Resolves once pi has exited.
  exited: Promise<void>;
}

// What to run: pi's arguments, its folder, the prompt, the time limit, and
// the hooks told of the process and of each record it prints.
interface RpcRun {
  args: readonly string[];
  cwd: string;
  prompt: string;
  timeoutMs: number;
  onSpawn: (rpc: RpcProcess) => void;
  onRecord: (record: unknown) => void;
}

function recordOf(line: string): unknown {
  try {
    const record: unknown = JSON.parse(line);
    return record;
  } catch {
    return null;
  }
}

// Whether `record`, which answered command `id`, ends the session.
function endsSession(id: string, record: unknown): boolean {
  const response = RESPONSE.safeParse(record);
  return (
    id === PROMPT_ID &&
    response.success &&
    (!response.data.success || HANDLED.safeParse(record).success)
  );
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

// Splits stdout's chunks into lines on LF only, as pi's RPC framing says,
// and hands each line to `onLine`; `flush` hands over an unterminated last.
function framerOf(onLine: (line: string) => void): {
  push: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    push: (chunk: string): void => {
      const lines = `${buffer}${chunk}`.split("\n");
      buffer = lines.pop() ?? "";
      lines.forEach(onLine);
    },
    flush: (): void => {
      if (buffer !== "") {
        onLine(buffer);
      }
      buffer = "";
    },
  };
}

function handleOf(
  child: ChildProcessWithoutNullStreams,
  channel: Channel,
): RpcProcess {
  const exited = new Promise<void>((done: () => void): void => {
    child.on("close", (): void => done());
  });
  return {
    pid: child.pid ?? null,
    send: (command: RpcCommand): Promise<RpcAnswer> => channel.send(command),
    kill: (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    },
    exited,
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
      stdio: "pipe",
      detached: true,
    });
    const channel = channelOf(child.stdin);
    const framer = framerOf((line: string): void => {
      exit.stdout += `${line}\n`;
      const record = recordOf(line.replace(TRAILING_CR, ""));
      if (record !== null) {
        run.onRecord(record);
        readRecord(record, child.stdin, channel);
      }
    });
    const timer = setTimeout((): void => {
      exit.timedOut = true;
      child.kill("SIGTERM");
    }, run.timeoutMs);
    function noteError(error: Error): void {
      exit.stderr += `${PI}: ${error.message}\n`;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", framer.push);
    child.stderr.on("data", (chunk: string): void => {
      exit.stderr += chunk;
    });
    child.stdin.on("error", noteError);
    child.on("error", noteError);
    child.on("close", (code: number | null): void => {
      clearTimeout(timer);
      framer.flush();
      channel.endAll();
      resolve({ ...exit, code });
    });
    run.onSpawn(handleOf(child, channel));
    child.stdin.write(
      `${JSON.stringify({ id: PROMPT_ID, type: "prompt", message: run.prompt })}\n`,
    );
  });
}

export type { RpcAnswer, RpcCommand, RpcProcess };
export { runRpc };
