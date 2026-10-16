// A launch's record in job.json (src/job/status.ts): its pid, session file,
// last event, consecutive failures of one tool and the last one's error,
// token usage, token budget, context size, peak and first turn context,
// turns, stop at the hard context limit and outcome, and how a record a
// session prints changes it.

import { z } from "zod";
import { turnContext } from "./context-watch.ts";
import type { ToolFailure } from "./raw-results.ts";
import {
  addUsage,
  recordFacts,
  USAGE,
  usageTotal,
  ZERO_USAGE,
} from "./raw-results.ts";

const LAUNCH_OUTCOME = z.enum(["ok", "failed"]);
const LAUNCH = z.object({
  key: z.string(),
  kind: z.enum(["session", "ops"]),
  pid: z.number().nullable(),
  session: z.string().nullable(),
  startedAt: z.string(),
  lastEventAt: z.string().nullable(),
  // Consecutive failed calls of the tool that failed last; a success or
  // another tool's failure starts the count again.
  toolFailures: z.number(),
  lastToolFailure: z
    .object({ tool: z.string(), error: z.string() })
    .nullable()
    .default(null),
  usage: USAGE,
  // A writer session's token budget, which the watchdog stops it past; null
  // for an ops launch or any other session.
  tokenBudget: z.number().nullable().default(null),
  // The token total of the latest message that reported usage: the session's
  // live context size, 0 before the first one.
  contextTokens: z.number().default(0),
  // The highest turn context the session has shown (context-watch.ts).
  peakContext: z.number().default(0),
  // The first turn's context, null before the first turn.
  firstContext: z.number().nullable().default(null),
  // The messages that reported usage.
  turns: z.number().default(0),
  // A writer session's stop at the hard context limit, if it was stopped.
  // An older file's stop may carry a `result`, which is dropped.
  contextStop: z.object({ context: z.number() }).nullable().default(null),
  resumed: z.boolean(),
  outcome: LAUNCH_OUTCOME.nullable(),
});

type LaunchOutcome = z.infer<typeof LAUNCH_OUTCOME>;
type LaunchRecord = z.infer<typeof LAUNCH>;

// The launch's count of consecutive failures of one tool after a call ends
// with `failure`, or with success when it is null.
function failuresAfter(
  launch: LaunchRecord,
  failure: ToolFailure | null,
): number {
  if (failure === null) {
    return 0;
  }
  const { toolFailures, lastToolFailure } = launch;
  if (failure.tool === lastToolFailure?.tool) {
    return toolFailures + 1;
  }
  return 1;
}

// `launch` once session record `record` is read.
function withRecord(launch: LaunchRecord, record: unknown): LaunchRecord {
  const { usage, toolEnd } = recordFacts(record);
  let { toolFailures, lastToolFailure, contextTokens, peakContext } = launch;
  let { firstContext, turns } = launch;
  if (toolEnd !== null) {
    toolFailures = failuresAfter(launch, toolEnd.failure);
    lastToolFailure = toolEnd.failure;
  }
  if (usage !== null) {
    contextTokens = usageTotal(usage);
    peakContext = Math.max(peakContext, turnContext(usage));
    firstContext ??= turnContext(usage);
    turns += 1;
  }
  return {
    ...launch,
    lastEventAt: new Date().toISOString(),
    toolFailures,
    lastToolFailure,
    contextTokens,
    usage: addUsage(launch.usage, usage ?? ZERO_USAGE),
    peakContext,
    firstContext,
    turns,
  };
}

// A launch's record as it starts, before any event.
function startedRecord(
  start: Pick<
    LaunchRecord,
    "key" | "kind" | "pid" | "session" | "resumed" | "usage" | "tokenBudget"
  >,
): LaunchRecord {
  return {
    ...start,
    startedAt: new Date().toISOString(),
    lastEventAt: null,
    toolFailures: 0,
    lastToolFailure: null,
    contextTokens: 0,
    peakContext: 0,
    firstContext: null,
    turns: 0,
    contextStop: null,
    outcome: null,
  };
}

export type { LaunchOutcome, LaunchRecord };
export { LAUNCH, startedRecord, withRecord };
