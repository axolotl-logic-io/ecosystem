import { z } from "zod";

const timestampSchema = z.union([z.string(), z.number()]).nullish();
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

export type { ContactEvent, SubagentStatus, Timestamp };
export { eventSchema, installedSchema, jsonl, parse, subagentStatusSchema };
