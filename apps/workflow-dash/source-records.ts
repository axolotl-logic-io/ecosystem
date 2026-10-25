import { z } from "zod";

const timestampSchema = z.union([z.string(), z.number()]).nullish();
const launchSchema = z.object({
  key: z.string(),
  kind: z.string().nullish(),
  startedAt: timestampSchema,
  lastEventAt: timestampSchema,
  scope: z.string().nullish(),
  outcome: z.unknown().optional(),
  turns: z.number().nullish(),
  usage: z.unknown().optional(),
});
const jobRecordSchema = z.object({
  id: z.string().nullish(),
  pid: z.number().nullish(),
  stage: z.string().nullish(),
  scope: z.string().nullish(),
  startedAt: timestampSchema,
  endedAt: timestampSchema,
  outcome: z.unknown().optional(),
  reason: z.unknown().optional(),
  stopReason: z.unknown().optional(),
  history: z.boolean().optional(),
  launches: z.array(launchSchema),
});
const journalSchema = z.object({
  kind: z.string().nullish(),
  job: z.string().nullish(),
  at: timestampSchema,
  jobStartedAt: timestampSchema,
  stages: z.union([z.array(z.string()), z.string()]).optional(),
  role: z.string().nullish(),
  seconds: z.number().nullish(),
  outcome: z.unknown().optional(),
  reason: z.unknown().optional(),
  stopReason: z.unknown().optional(),
});
const contentSchema = z.object({
  type: z.string(),
  id: z.string().nullish(),
  name: z.string().nullish(),
  arguments: z.object({ command: z.string().nullish() }).optional(),
});
const sessionSchema = z.object({
  type: z.literal("message"),
  timestamp: timestampSchema,
  message: z.object({
    role: z.string(),
    timestamp: timestampSchema,
    toolCallId: z.string().nullish(),
    content: z.union([z.string(), z.array(contentSchema)]).optional(),
  }),
});
const stepSchema = z.object({
  currentTool: z.string().nullish(),
  currentToolArgs: z.string().nullish(),
  task: z.string().nullish(),
  sessionName: z.string().nullish(),
});
const subagentStatusSchema = stepSchema.extend({
  state: z.string(),
  startedAt: timestampSchema,
  lastActivityAt: timestampSchema,
  lastUpdate: timestampSchema,
  task: z.string().nullish(),
  account: z.unknown().optional(),
  steps: z.array(stepSchema).optional(),
});
const eventSchema = z.object({
  type: z.enum(["tool_execution_start", "tool_execution_end"]),
  toolName: z.literal("contact_supervisor"),
  toolCallId: z.string(),
  args: z
    .object({ reason: z.string().nullish(), message: z.string().nullish() })
    .optional(),
});
const installedSchema = z.object({
  sha: z.string().nullish(),
  commit: z.string().nullish(),
  head: z.string().nullish(),
});
type Timestamp = z.infer<typeof timestampSchema>;
type Launch = z.infer<typeof launchSchema>;
type JobData = z.infer<typeof jobRecordSchema>;
type JournalRecord = z.infer<typeof journalSchema>;
type SessionRecord = z.infer<typeof sessionSchema>;
type SubagentStatus = z.infer<typeof subagentStatusSchema>;
type ContactEvent = z.infer<typeof eventSchema>;

function parse(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return null;
  }
}

const objectSchema = z.record(z.string(), z.unknown());
function jsonl(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    const result = objectSchema.safeParse(parse(line));
    if (result.success) {
      return [result.data];
    }
    return [];
  });
}

export type {
  ContactEvent,
  JobData,
  JournalRecord,
  Launch,
  SessionRecord,
  SubagentStatus,
  Timestamp,
};
export {
  eventSchema,
  installedSchema,
  jobRecordSchema,
  journalSchema,
  jsonl,
  parse,
  sessionSchema,
  subagentStatusSchema,
};
