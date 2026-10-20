import { z } from "zod";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const MIN_INTERVAL_SECONDS = 10;
const DEFAULT_INTERVAL_SECONDS = 60;
const MAX_POLL_SECONDS = 3600;
const MAX_HEARTBEAT_SECONDS = 300;
const MAX_BACKOFF_SECONDS = 86_400;
const MAX_PAGE_BUDGET = 1000;
const DEFAULT_PAGE_BUDGET = 100;
const ASSIGNMENT = z
  .object({
    enabled: z.literal(true),
    workers: z
      .array(
        z.object({
          id: z.string().regex(ID),
          login: z.string().regex(LOGIN),
          roles: z.enum(["development", "review"]),
        }),
      )
      .min(2),
    pollSeconds: z
      .number()
      .int()
      .min(MIN_INTERVAL_SECONDS)
      .max(MAX_POLL_SECONDS)
      .default(DEFAULT_INTERVAL_SECONDS),
    maxBackoffSeconds: z
      .number()
      .int()
      .min(DEFAULT_INTERVAL_SECONDS)
      .max(MAX_BACKOFF_SECONDS)
      .default(MAX_POLL_SECONDS),
    heartbeatSeconds: z
      .number()
      .int()
      .min(MIN_INTERVAL_SECONDS)
      .max(MAX_HEARTBEAT_SECONDS)
      .default(DEFAULT_INTERVAL_SECONDS),
    pageBudget: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_BUDGET)
      .default(DEFAULT_PAGE_BUDGET),
  })
  .superRefine((settings, ctx) => {
    const keys: ("id" | "login" | "roles")[] = ["id", "login", "roles"];
    for (const key of keys) {
      const values = settings.workers.map((worker) =>
        worker[key].toLowerCase(),
      );
      if (new Set(values).size !== values.length) {
        ctx.addIssue({ code: "custom", message: `ambiguous worker ${key}` });
      }
    }
    if (settings.pollSeconds > settings.maxBackoffSeconds) {
      ctx.addIssue({ code: "custom", message: "poll exceeds maximum backoff" });
    }
  });

const CHECKPOINT = z.object({
  branch: z.string().min(1),
  code: SHA.nullable(),
  wiki: SHA.nullable(),
  pr: z.number().int().positive().nullable(),
  inputs: z.string().min(1),
  at: z.iso.datetime(),
});
const HANDOFF = z.object({
  id: z.uuid(),
  assignment: z.number().int().positive().nullable().default(null),
  eventsBefore: z.array(z.number().int().positive()).default([]),
  reviewsBefore: z.array(z.number().int().positive()).default([]),
  checkpoint: CHECKPOINT,
  phase: z.enum(["pending", "requested", "accepted"]),
  request: z.number().int().positive().nullable(),
  review: z.number().int().positive().nullable(),
});
const COORDINATION = z.object({
  pending: z
    .object({
      kind: z.string(),
      expected: z.string().nullable(),
      at: z.iso.datetime(),
    })
    .nullable()
    .default(null),
  localRecovery: z.boolean().default(false),
  worker: z.string().nullable(),
  status: z.enum([
    "queued",
    "active",
    "blocked",
    "ready-for-handoff",
    "stalled",
    "completed",
  ]),
  reason: z.string().nullable(),
  heartbeat: z.iso.datetime().nullable(),
  retryAt: z.iso.datetime().nullable(),
  checkpoint: CHECKPOINT.nullable(),
  handoff: HANDOFF.nullable(),
});
const EXECUTION = z.object({
  scope: z
    .object({ manifest: z.string(), config: z.string(), brainPath: z.string() })
    .optional(),
  worker: z.string(),
  issue: z.number().int().positive(),
  stage: z.enum(["author", "implement", "review", "merge"]),
  token: SHA,
  turn: SHA.nullable(),
  handoff: z.uuid().nullable(),
});
type Execution = z.infer<typeof EXECUTION>;
type Coordination = z.infer<typeof COORDINATION>;
type Worker = z.infer<typeof ASSIGNMENT>["workers"][number];

function emptyCoordination(): Coordination {
  return {
    pending: null,
    localRecovery: false,
    worker: null,
    status: "queued",
    reason: null,
    heartbeat: null,
    retryAt: null,
    checkpoint: null,
    handoff: null,
  };
}

export type { Coordination, Execution, Worker };
export {
  ASSIGNMENT,
  COORDINATION,
  DEFAULT_PAGE_BUDGET,
  EXECUTION,
  emptyCoordination,
};
