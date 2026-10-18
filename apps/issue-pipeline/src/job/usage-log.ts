// The usage log (`log-usage-at-finish` in the wiki's Pipeline-Roles-Shared
// page): what each finished session and job spent, as public records in a
// hidden block of the issue's usage comments (usage-comment.ts). This module
// alone owns the records' fields and the kinds of value they may hold
// (numbers, booleans, times and names from fixed sets, never free text). It
// does no I/O.

import { z } from "zod";
import type { RoleName } from "../roles/registry.ts";
import { ROLE_NAMES } from "../roles/registry.ts";
import type { JsonSchema } from "../workflow/schemas.ts";
import { isRecord } from "../workflow/stages/reply-guards.ts";
import { STAGE_ORDER } from "../workflow/sweep-config.ts";
import type { ContextLimits } from "./context-watch.ts";
import type { JobEntry, SessionEntry } from "./run-usage.ts";
import { BLOCK_END } from "./usage-comment.ts";
import type { ToolOutput, ToolUse } from "./usage-tally.ts";

// A name from a fixed set that pi or a role supplies: one token, with no
// space, `/`, `<` or `>`.
const NAME = /^[A-Za-z0-9][\w.:-]{0,99}$/u;
// A model id: a NAME, or a provider's NAME and the model's, joined by one
// `/`, as in `anthropic/claude-opus-5-5`.
const MODEL = /^[A-Za-z0-9][\w.:-]{0,99}(?:\/[A-Za-z0-9][\w.:-]{0,99})?$/u;
const REPO = /^[\w.-]+\/[\w.-]+$/u;
const WHITESPACE = /\s/u;
// The name a tool whose name isn't a NAME is counted under.
const OTHER_TOOL = "other";

type Ended = "reply" | "handoff" | "context-stop" | "error" | "aborted";

const ENDED: readonly Ended[] = [
  "reply",
  "handoff",
  "context-stop",
  "error",
  "aborted",
];

// The job's identity and settings a record carries: `job` is its random id
// and `jobStartedAt` its start, which its commits' Pipeline-Session trailers
// name.
interface UsageContext {
  repo: string;
  issue: number;
  job: string;
  jobStartedAt: string;
  role: RoleName;
  limits: ContextLimits;
}

const COUNT = z.number().nonnegative();
const NAMED = z.string().regex(NAME);
const STAGE = z.enum([...STAGE_ORDER, "done"]);
const RELATIVE_PATH = z
  .string()
  .min(1)
  .refine(
    (file) =>
      !(
        file.startsWith("/") ||
        file.startsWith("~") ||
        file.split("/").includes("..") ||
        WHITESPACE.test(file)
      ),
    "must be a relative path",
  );
// The cache writes that last an hour and the cost in US dollars are missing
// from the records written before they were recorded, as are a record's
// `jobStartedAt` and a session record's `key`.
const TOKENS = z.strictObject({
  input: COUNT,
  output: COUNT,
  cacheRead: COUNT,
  cacheWrite: COUNT,
  cacheWrite1h: COUNT.optional(),
  cost: COUNT.optional(),
});
const IDENTITY = {
  at: z.iso.datetime(),
  repo: z.string().regex(REPO),
  issue: z.number().int().positive(),
  job: z.uuid(),
  jobStartedAt: z.iso.datetime().optional(),
  role: z.enum(ROLE_NAMES),
};
const SESSION_RECORD = z.strictObject({
  kind: z.literal("session"),
  ...IDENTITY,
  key: NAMED.optional(),
  stage: STAGE,
  state: NAMED,
  name: NAMED,
  agent: NAMED,
  model: z.string().regex(MODEL),
  attempt: z.number().int().positive(),
  ended: z.enum(ENDED),
  reply: NAMED.nullable(),
  seconds: COUNT,
  turns: COUNT,
  tokens: TOKENS,
  context: z.strictObject({
    first: COUNT,
    peak: COUNT,
    atFinish: COUNT,
    soft: COUNT,
    hard: COUNT,
    window: COUNT.nullable(),
    steered: z.boolean(),
  }),
  task: z.strictObject({ chars: COUNT, files: z.record(RELATIVE_PATH, COUNT) }),
  tools: z.record(NAMED, z.strictObject({ calls: COUNT, outputChars: COUNT })),
  largestToolOutput: z.strictObject({ tool: NAMED, chars: COUNT }).nullable(),
});
const JOB_RECORD = z.strictObject({
  kind: z.literal("job"),
  ...IDENTITY,
  stages: z.array(STAGE),
  // A role run's end (runner.ts), or a sweep's outcome for its issue.
  outcome: NAMED,
  seconds: COUNT,
  tokens: TOKENS,
  issueTokens: COUNT,
});
const USAGE_RECORD = z.discriminatedUnion("kind", [SESSION_RECORD, JOB_RECORD]);

type UsageRecord = z.infer<typeof USAGE_RECORD>;
type SessionRecord = z.infer<typeof SESSION_RECORD>;

// The record's own fields, before the serializer checks their values.
type Unchecked<T> = {
  [K in keyof T]: T[K] extends string ? string : Unchecked<T[K]>;
};

function toolName(tool: string): string {
  if (NAME.test(tool)) {
    return tool;
  }
  return OTHER_TOOL;
}

function toolsOf(
  tools: Readonly<Record<string, ToolUse>>,
): Record<string, ToolUse> {
  const named = new Map<string, ToolUse>();
  for (const [tool, use] of Object.entries(tools)) {
    const name = toolName(tool);
    const sum = named.get(name) ?? { calls: 0, outputChars: 0 };
    named.set(name, {
      calls: sum.calls + use.calls,
      outputChars: sum.outputChars + use.outputChars,
    });
  }
  return Object.fromEntries(named);
}

// The reply's decision, verdict or status, when its value is one its
// property's enum in `schema` lists.
function replyOf(reply: unknown, schema: JsonSchema): string | null {
  if (!isRecord(reply)) {
    return null;
  }
  const { decision, verdict, status } = reply;
  const { properties = {} } = schema;
  const {
    decision: decisionSchema,
    verdict: verdictSchema,
    status: statusSchema,
  } = properties;
  const fields: [unknown, JsonSchema | undefined][] = [
    [decision, decisionSchema],
    [verdict, verdictSchema],
    [status, statusSchema],
  ];
  for (const [value, property] of fields) {
    if (typeof value === "string" && property?.enum?.includes(value)) {
      return value;
    }
  }
  return null;
}

// The `session` record of a finished session.
function usageRecord(
  launch: SessionEntry,
  context: UsageContext,
): Unchecked<SessionRecord> {
  const { repo, issue, job, jobStartedAt, role, limits } = context;
  const { launch: used } = launch;
  let largestToolOutput: ToolOutput | null = null;
  if (used.largest !== null) {
    const { tool, chars } = used.largest;
    largestToolOutput = { tool: toolName(tool), chars };
  }
  return {
    kind: "session",
    at: launch.at,
    repo,
    issue,
    job,
    jobStartedAt,
    role,
    key: launch.key,
    stage: launch.stage,
    state: launch.state,
    name: launch.name,
    agent: launch.agent,
    model: launch.model,
    attempt: launch.attempt,
    ended: launch.ended,
    reply: replyOf(launch.reply, launch.schema),
    seconds: used.seconds,
    turns: used.turns,
    tokens: used.tokens,
    context: {
      first: used.first,
      peak: used.peak,
      atFinish: used.atFinish,
      soft: limits.soft,
      hard: limits.hard,
      window: null,
      steered: used.steered,
    },
    task: { chars: launch.taskChars, files: {} },
    tools: toolsOf(used.tools),
    largestToolOutput,
  };
}

// The `job` record of a finished run.
function jobRecord(
  job: JobEntry,
  context: UsageContext,
): Unchecked<z.infer<typeof JOB_RECORD>> {
  const { repo, issue, jobStartedAt, role } = context;
  const { at, outcome, seconds, tokens, issueTokens } = job;
  const stages = [...job.stages];
  return {
    kind: "job",
    at,
    repo,
    issue,
    job: context.job,
    jobStartedAt,
    role,
    stages,
    outcome,
    seconds,
    tokens,
    issueTokens,
  };
}

// The record as one JSON line. It throws on an unknown key, a value of no
// allowed kind, or a line that would end the comment's hidden block.
function serializeUsage(record: unknown): string {
  const line = JSON.stringify(USAGE_RECORD.parse(record));
  if (line.includes(BLOCK_END)) {
    throw new Error(`usage: a record may not hold ${BLOCK_END}`);
  }
  return line;
}

// The record a line holds, or undefined when it holds none.
function parseUsageLine(line: string): UsageRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = USAGE_RECORD.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}

export type { Ended, UsageContext, UsageRecord };
export { jobRecord, parseUsageLine, serializeUsage, usageRecord };
