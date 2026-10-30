// The buddy runtime's local run observations, exactly as published in
// docs/reference/runtime-runs.md and exported as BUDDY_RUN and ACTION_RUN by
// apps/issue-pipeline/src/runtime/observations.ts, and the task app runs
// exported as TASK_RUN by apps/issue-pipeline/src/task-app/run-record.ts. Dash keeps this reader
// copy instead of importing the pipeline's writer module, whose imports read
// the pipeline's environment and configuration. test/runtime-runs.test.ts
// compares both copies' JSON Schemas through a pipeline subprocess, so a
// change on either side fails the dashboard gate.
import { z } from "zod";

const taskIds = [
  "implement",
  "verify",
  "fix",
  "land",
  "refactor-safely",
] as const;
const requirementsTasks = ["implement"] as const;
const revisionTasks = ["verify", "fix", "land", "refactor-safely"] as const;
const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const requirementsPattern = /^sha256:[0-9a-f]{64}$/u;
const repositoryPattern = /^[\w.-]+\/[\w.-]+$/u;

const taskIdSchema = z.enum(taskIds);
const runStateSchema = z.enum(["running", "waiting", "stopped", "ended"]);
const verdictSchema = z.enum(["passed", "failed", "refused", "unknown"]);
const time = z.iso.datetime();
const uuid = z.uuid();
const commit = z.string().regex(commitPattern);
const digest = z.string().regex(digestPattern);
const workItemSchema = z.strictObject({
  repo: z.string().regex(repositoryPattern),
  number: z.number().int().positive(),
});
const targetSchema = z.strictObject({
  branch: z.string().min(1),
  commit,
});
const bindingSchema = z.union([
  z.strictObject({
    workItem: workItemSchema,
    task: z.enum(requirementsTasks),
    target: targetSchema,
    requirements: z.string().regex(requirementsPattern),
  }),
  z.strictObject({
    workItem: workItemSchema,
    task: z.enum(revisionTasks),
    target: targetSchema,
    revision: z.strictObject({ code: commit, inputs: digest, policy: digest }),
  }),
]);
const causeSchema = z.strictObject({
  signal: z.string().min(1),
  recordId: z.number().int().positive(),
});
const executionSchema = z.strictObject({
  instance: z.string().uuid(),
  lane: z.string().min(1),
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
});
const stopSchema = z.strictObject({
  scope: z.enum(["buddy", "work-item"]),
  reason: z.string().min(1),
  requestedAt: time,
});
const loopSchema = z.strictObject({
  task: taskIdSchema,
  repo: z.string().min(1),
  state: z.enum(["idle", "acting", "waiting", "held", "stopped"]),
  reason: z.string().nullable(),
  polledAt: time.nullable(),
  action: uuid.nullable(),
});

const buddyRunSchema = z.strictObject({
  kind: z.literal("buddy-run"),
  version: z.literal(1),
  id: uuid,
  previous: uuid.nullable(),
  buddy: z.strictObject({
    name: z.string().min(1),
    role: z.enum(["developer", "gatekeeper"]),
    identity: z.string().min(1),
    config: z.string().min(1),
  }),
  tasks: z.array(taskIdSchema),
  scope: z.strictObject({
    organization: z.string().min(1),
    repositories: z.array(
      z.strictObject({
        config: z.string().min(1),
        repo: z.string().min(1),
        base: z.string().min(1),
        authorization: digest,
      }),
    ),
  }),
  accounts: z.array(
    z.strictObject({ provider: z.literal("github"), login: z.string() }),
  ),
  process: z.strictObject({
    pid: z.int().positive(),
    host: z.string().min(1),
    startedAt: time,
    observedAt: time,
  }),
  lease: z.strictObject({ seconds: z.int().positive(), expiresAt: time }),
  state: runStateSchema,
  outcome: z
    .strictObject({
      kind: z.enum(["stopped", "failed"]),
      reason: z.string().min(1),
      at: time,
    })
    .nullable(),
  stop: stopSchema.nullable(),
  loops: z.array(loopSchema),
  caps: z.array(
    z.strictObject({
      repo: z.string().min(1),
      modelSessions: z.int().positive(),
      testSlots: z.int().positive().nullable(),
    }),
  ),
});

const sessionSchema = z.strictObject({
  id: uuid,
  parent: uuid,
  key: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  phase: z.string().nullable(),
  commits: z.boolean(),
  pid: z.int().nullable(),
  reservation: z.strictObject({ slot: z.int().positive() }).nullable(),
  startedAt: time,
  endedAt: time.nullable(),
  outcome: z.enum(["ok", "failed"]).nullable(),
});
const operationSchema = z.strictObject({
  key: z.string().min(1),
  op: z.string().min(1),
  pid: z.int().nullable(),
  startedAt: time,
  endedAt: time.nullable(),
  outcome: z.enum(["ok", "failed"]).nullable(),
});
const reservationSchema = z.strictObject({
  resource: z.enum(["model-session", "test-slot", "target-write"]),
  slot: z.int().positive(),
  state: z.enum(["held", "released"]),
  reason: z.string().nullable(),
});

const actionRunSchema = z.strictObject({
  kind: z.literal("action-run"),
  version: z.literal(1),
  id: uuid,
  previous: uuid.nullable(),
  buddyRun: uuid,
  task: taskIdSchema,
  workItem: workItemSchema,
  binding: bindingSchema,
  cause: causeSchema,
  execution: executionSchema,
  mode: z.enum(["act", "recover"]),
  authorization: digest,
  state: runStateSchema,
  outcome: z.enum(["succeeded", "failed", "refused", "unknown"]).nullable(),
  verdict: verdictSchema.nullable(),
  reason: z.string().nullable(),
  stop: stopSchema.nullable(),
  checkpoint: z.strictObject({
    state: z.enum(["none", "saved", "uncertain"]),
    at: time.nullable(),
    reason: z.string().nullable(),
  }),
  ownership: z.strictObject({
    state: z.enum(["held", "released", "retained"]),
    reason: z.string().nullable(),
  }),
  sessions: z.array(sessionSchema),
  operations: z.array(operationSchema),
  reservations: z.array(reservationSchema),
  preserved: z.strictObject({
    checkout: z.string().nullable(),
    patches: z.array(z.string()),
  }),
});

const taskIdPattern = /^[a-z][a-z0-9-]*$/u;
const taskRunSchema = z.strictObject({
  kind: z.literal("task-run"),
  version: z.literal(1),
  id: uuid,
  task: z.string().regex(taskIdPattern),
  workItem: z.strictObject({
    repo: z.string().regex(repositoryPattern),
    number: z.number().int().positive(),
  }),
  account: z.string().min(1),
  claim: z.strictObject({
    start: z.number().int().positive().nullable(),
    removal: z.number().int().positive(),
  }),
  process: z.strictObject({
    pid: z.int().positive(),
    host: z.string().min(1),
  }),
  state: z.enum(["running", "ended"]),
  step: z.enum(["mark", "work", "unmark"]),
  outcome: z.enum(["succeeded", "failed", "stopped"]).nullable(),
  reason: z.string().nullable(),
  startedAt: time,
  endedAt: time.nullable(),
});

type BuddyRunObservation = z.infer<typeof buddyRunSchema>;
type ActionRunObservation = z.infer<typeof actionRunSchema>;
type TaskRunObservation = z.infer<typeof taskRunSchema>;

export type { ActionRunObservation, BuddyRunObservation, TaskRunObservation };
export { actionRunSchema, buddyRunSchema, taskRunSchema };
