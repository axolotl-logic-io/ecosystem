// The raw results a stage job hands the sweep's driver, in the shape that
// launch-results.ts parses: an ops child's exit as `{ ok, output, error }`, and
// a pi session's JSONL events as its structured output, error and summed
// token usage.

import { z } from "zod";

// How much of a child's stderr an error keeps.
const ERROR_TAIL = 500;
const TIMED_OUT = "timed out before it exited";
const NO_OUTPUT = "no structured output";
const LINE_BREAK = /\r?\n/u;

// How a child process ended: its exit code (null when a signal ended it),
// what it printed, and whether the job's timeout stopped it.
interface ProcessExit {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface OpsRaw {
  ok: boolean;
  output: string;
  error: string;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface SessionRaw {
  ok: boolean;
  structuredOutput: Record<string, unknown> | null;
  error: string | null;
  key: string;
  agent: string;
  results: [{ usage: Usage }];
}

// The launch a session ran for.
interface SessionLaunch {
  key: string;
  agent: string;
}

const COUNT = z.number().catch(0);
const USAGE = z.object({
  input: COUNT,
  output: COUNT,
  cacheRead: COUNT,
  cacheWrite: COUNT,
});
const MESSAGE_END = z.object({
  type: z.literal("message_end"),
  message: z.object({
    role: z.literal("assistant"),
    usage: USAGE.optional(),
    errorMessage: z.string().optional(),
  }),
});
const OUTPUT_END = z.object({
  type: z.literal("tool_execution_end"),
  toolName: z.literal("structured_output"),
  isError: z.literal(false).optional(),
  result: z.object({ details: z.record(z.string(), z.unknown()) }),
});
const EVENT = z.union([MESSAGE_END, OUTPUT_END]);

type SessionEvent = z.infer<typeof EVENT>;

// What a session's events add up to.
interface SessionTally {
  usage: Usage;
  structuredOutput: Record<string, unknown> | null;
  errorMessage: string | null;
}

function tail(text: string): string {
  return text.trim().slice(-ERROR_TAIL);
}

function exitedClean(exit: ProcessExit): boolean {
  return exit.code === 0 && !exit.timedOut;
}

// An ops child's result: ok only when it exited 0 within its timeout.
function opsRaw(exit: ProcessExit): OpsRaw {
  let error = tail(exit.stderr);
  if (exit.timedOut) {
    error = TIMED_OUT;
  }
  return { ok: exitedClean(exit), output: exit.stdout, error };
}

// The line as a session event the result reads, or null for any other line.
function eventOf(line: string): SessionEvent | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const event = EVENT.safeParse(parsed);
  if (!event.success) {
    return null;
  }
  return event.data;
}

function addEvent(tally: SessionTally, event: SessionEvent): SessionTally {
  if (event.type === "tool_execution_end") {
    return { ...tally, structuredOutput: event.result.details };
  }
  const { usage, errorMessage } = event.message;
  const sum = tally.usage;
  return {
    structuredOutput: tally.structuredOutput,
    errorMessage: errorMessage ?? tally.errorMessage,
    usage: {
      input: sum.input + (usage?.input ?? 0),
      output: sum.output + (usage?.output ?? 0),
      cacheRead: sum.cacheRead + (usage?.cacheRead ?? 0),
      cacheWrite: sum.cacheWrite + (usage?.cacheWrite ?? 0),
    },
  };
}

function tallyOf(stdout: string): SessionTally {
  const empty: SessionTally = {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    structuredOutput: null,
    errorMessage: null,
  };
  return stdout
    .split(LINE_BREAK)
    .map(eventOf)
    .reduce((tally: SessionTally, event: SessionEvent | null) => {
      if (event === null) {
        return tally;
      }
      return addEvent(tally, event);
    }, empty);
}

// Why a session failed: its last error message, the timeout, the end of its
// stderr, or that it gave no structured output.
function sessionError(exit: ProcessExit, tally: SessionTally): string {
  if (tally.errorMessage !== null) {
    return tally.errorMessage;
  }
  if (exit.timedOut) {
    return TIMED_OUT;
  }
  return tail(exit.stderr) || NO_OUTPUT;
}

// A pi session's result from its exit and JSONL events: ok only when it
// exited 0 within its timeout and gave structured output. Its usage is the
// sum of its assistant messages', reported even when it failed.
function sessionRaw(launch: SessionLaunch, exit: ProcessExit): SessionRaw {
  const tally = tallyOf(exit.stdout);
  const ok = exitedClean(exit) && tally.structuredOutput !== null;
  let error: string | null = null;
  if (!ok) {
    error = sessionError(exit, tally);
  }
  return {
    ok,
    structuredOutput: tally.structuredOutput,
    error,
    key: launch.key,
    agent: launch.agent,
    results: [{ usage: tally.usage }],
  };
}

// A session that never started, failed with `error`.
function failedSession(launch: SessionLaunch, error: string): SessionRaw {
  return sessionRaw(launch, {
    code: null,
    stdout: "",
    stderr: error,
    timedOut: false,
  });
}

export type { OpsRaw, ProcessExit, SessionLaunch, SessionRaw };
export { failedSession, opsRaw, sessionRaw };
