import { z } from "zod";

const identifierLimit = 500;
const bodyLimit = 262_144;
const batchLimit = 2000;
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.iso.datetime();
const usageSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
});
const entitySchema = z.object({
  id: z.string().min(1).max(identifierLimit),
  kind: z.enum(["work", "buddy", "action", "session", "health"]),
  repo: z.string().nullable(),
  issue: z.int().positive().nullable(),
  parent: z.string().nullable(),
  title: z.string(),
  state: z.string(),
  task: z.string().nullable(),
  phase: z.string().nullable(),
  actor: z.string().nullable(),
  model: z.string().nullable(),
  window: count.positive().nullable(),
  startedAt: time.nullable(),
  endedAt: time.nullable(),
  activityAt: time.nullable(),
  sourceAt: time,
  reason: z.string().nullable(),
});
const eventSchema = z.object({
  session: z.string(),
  source: z.string(),
  position: count,
  at: time.nullable(),
  kind: z.enum([
    "message",
    "reasoning",
    "tool",
    "compaction",
    "activity",
    "error",
    "policy",
    "usage",
  ]),
  label: z.string(),
  body: z.string().max(bodyLimit),
  reasoning: z.string().max(bodyLimit).nullable(),
  usage: usageSchema.nullable(),
  context: count.nullable(),
  window: count.positive().nullable(),
  target: count.positive().nullable(),
  compacted: z.boolean(),
});
const batchSchema = z
  .object({
    source: z.string(),
    offset: count,
    next: count,
    events: z.array(eventSchema).max(batchLimit),
  })
  .refine(
    (batch): boolean =>
      batch.next >= batch.offset &&
      batch.events.every(
        (event): boolean =>
          event.source === batch.source &&
          event.position >= batch.offset &&
          event.position < batch.next,
      ),
  );
type MonitorEntity = z.infer<typeof entitySchema>;
type MonitorEvent = z.infer<typeof eventSchema>;
type MonitorBatch = z.infer<typeof batchSchema>;
type TokenUsage = z.infer<typeof usageSchema>;

export type { MonitorBatch, MonitorEntity, MonitorEvent, TokenUsage };
export { batchSchema, entitySchema, eventSchema, usageSchema };
