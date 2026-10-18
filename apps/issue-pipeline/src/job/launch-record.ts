// A launch's record in job.json (src/job/status.ts): its pid, session file,
// a session's write authority and reviewer phase, last event, consecutive failures of one tool and the last one's error,
// token usage, context size, peak and first turn context, turns, the pushes
// its commits made, and outcome, and how a record a session prints changes
// it. The context figures are records, never limits (`no-session-budgets`).

import { z } from "zod";
import type { ToolFailure } from "./raw-results.ts";
import { recordFacts } from "./raw-results.ts";
import { SESSION_PHASES } from "./role-context.ts";
import {
  addUsage,
  turnContext,
  USAGE,
  usageTotal,
  ZERO_USAGE,
} from "./token-usage.ts";

const LAUNCH_OUTCOME = z.enum(["ok", "failed"]);
// One push the job made for a writer session's `pipeline_commit`: the repo,
// the head it pushed, and when.
const PUSH = z.object({
  repo: z.enum(["code", "wiki"]),
  sha: z.string(),
  at: z.string(),
});
const LAUNCH = z.object({
  key: z.string(),
  kind: z.enum(["session", "ops"]),
  pid: z.number().nullable(),
  session: z.string().nullable(),
  // Whether the session was given commit authority, and the reviewer phase
  // it was labelled with; null for an ops launch, for a session with no
  // phase, and in a file written before they were recorded.
  commits: z.boolean().nullable().default(null),
  phase: z.enum(SESSION_PHASES).nullable().default(null),
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
  // The token total of the latest message that reported usage: the session's
  // live context size, 0 before the first one.
  contextTokens: z.number().default(0),
  // The highest turn context the session has shown (turnContext).
  peakContext: z.number().default(0),
  // The first turn's context, null before the first turn.
  firstContext: z.number().nullable().default(null),
  // The messages that reported usage.
  turns: z.number().default(0),
  // The pushes the job made for the session's commits, oldest first.
  pushes: z.array(PUSH).default([]),
  outcome: LAUNCH_OUTCOME.nullable(),
});

type LaunchOutcome = z.infer<typeof LAUNCH_OUTCOME>;
type LaunchRecord = z.infer<typeof LAUNCH>;
type LaunchPush = z.infer<typeof PUSH>;

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

// A launch's record as it starts, before any event. A session names its
// write authority and phase; an ops launch has neither.
function startedRecord(
  start: Pick<LaunchRecord, "key" | "kind" | "pid" | "session"> &
    Partial<Pick<LaunchRecord, "commits" | "phase">>,
): LaunchRecord {
  return {
    ...start,
    commits: start.commits ?? null,
    phase: start.phase ?? null,
    usage: ZERO_USAGE,
    startedAt: new Date().toISOString(),
    lastEventAt: null,
    toolFailures: 0,
    lastToolFailure: null,
    contextTokens: 0,
    peakContext: 0,
    firstContext: null,
    turns: 0,
    pushes: [],
    outcome: null,
  };
}

export type { LaunchOutcome, LaunchPush, LaunchRecord };
export { LAUNCH, startedRecord, withRecord };
