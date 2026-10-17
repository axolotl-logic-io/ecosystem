// The raw results a stage job hands the sweep's driver, in the shape that
// launch-results.ts parses: an ops child's exit as `{ ok, output, error }`, and
// a pi session's RPC records as its structured output, error and summed
// token usage. It alone knows the shape of the records it reads.

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

// A failed tool call: the tool's name and the error text it returned.
interface ToolFailure {
  tool: string;
  error: string;
}

// What a record tells: an assistant message's usage and text (null when it
// has none), and a tool call's end: the tool, the length of its result's
// text, and its failure, or null when it succeeded.
interface RecordFacts {
  usage: Usage | null;
  text: string | null;
  toolEnd: {
    tool: string;
    outputChars: number;
    failure: ToolFailure | null;
  } | null;
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
    content: z.array(z.unknown()).catch([]),
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
// pi's answer to the prompt command when it refused the prompt.
const PROMPT_REJECTED = z.object({
  type: z.literal("response"),
  command: z.literal("prompt"),
  success: z.literal(false),
  error: z.string().catch("pi rejected the prompt"),
});
const EVENT = z.union([MESSAGE_END, OUTPUT_END, PROMPT_REJECTED]);
const TOOL_TEXT = z.object({ type: z.literal("text"), text: z.string() });
const TOOL_END = z.object({
  type: z.literal("tool_execution_end"),
  toolName: z.string().catch("unknown"),
  isError: z.boolean(),
  result: z
    .object({ content: z.array(z.unknown()).catch([]) })
    .catch({ content: [] }),
});
// How much of a failed tool call's error text the status keeps.
const TOOL_ERROR_CHARS = 2000;
const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

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
  return EVENT.safeParse(parsed).data ?? null;
}

// The two usages summed.
function addUsage(sum: Usage, usage: Usage): Usage {
  return {
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
  };
}

// Every token the usage counts: input, output and both cache counts.
function usageTotal(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function addEvent(tally: SessionTally, event: SessionEvent): SessionTally {
  if (event.type === "tool_execution_end") {
    return { ...tally, structuredOutput: event.result.details };
  }
  if (event.type === "response") {
    return { ...tally, errorMessage: event.error };
  }
  const { usage, errorMessage } = event.message;
  return {
    structuredOutput: tally.structuredOutput,
    errorMessage: errorMessage ?? tally.errorMessage,
    usage: addUsage(tally.usage, usage ?? ZERO_USAGE),
  };
}

// The text parts of a tool result's or an assistant message's content.
function toolTexts(content: readonly unknown[]): string[] {
  return content.flatMap((part) => {
    const text = TOOL_TEXT.safeParse(part);
    if (text.success) {
      return [text.data.text];
    }
    return [];
  });
}

// What a record a session printed tells the job: the usage and text of an
// assistant message, and which tool call ended, its output's length, and how
// it failed.
function recordFacts(record: unknown): RecordFacts {
  const message = MESSAGE_END.safeParse(record);
  const tool = TOOL_END.safeParse(record);
  let usage: Usage | null = null;
  let text: string | null = null;
  if (message.success) {
    usage = message.data.message.usage ?? null;
    text = toolTexts(message.data.message.content).join("\n").trim() || null;
  }
  if (!tool.success) {
    return { usage, text, toolEnd: null };
  }
  const { toolName: name, isError, result } = tool.data;
  const texts = toolTexts(result.content);
  const outputChars = texts.reduce((sum, part) => sum + part.length, 0);
  let failure: ToolFailure | null = null;
  if (isError) {
    const error = texts.join("\n").slice(0, TOOL_ERROR_CHARS);
    failure = { tool: name, error };
  }
  return { usage, text, toolEnd: { tool: name, outputChars, failure } };
}

function tallyOf(stdout: string, start: Usage): SessionTally {
  const empty: SessionTally = {
    usage: start,
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

// A pi session's result from its exit and RPC records: ok only when it
// exited 0 within its timeout and gave structured output, and failed with
// the error of a rejected prompt. Its usage is `start` (what a resumed
// session spent before) plus its assistant messages', reported even when it
// failed.
function sessionRaw(
  launch: SessionLaunch,
  exit: ProcessExit,
  start: Usage = ZERO_USAGE,
): SessionRaw {
  const tally = tallyOf(exit.stdout, start);
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

export type {
  OpsRaw,
  ProcessExit,
  SessionLaunch,
  SessionRaw,
  ToolFailure,
  Usage,
};
export {
  addUsage,
  failedSession,
  opsRaw,
  recordFacts,
  sessionRaw,
  USAGE,
  usageTotal,
  ZERO_USAGE,
};
