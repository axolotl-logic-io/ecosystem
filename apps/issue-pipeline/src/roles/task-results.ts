// What the roles read and record of revision-bound task results (#183,
// #186): the next ready task (the task-readiness op), one binding's status,
// and an attempt or result appended through the job's recorder, the landing
// account. A role never builds a binding from saved state: it takes the
// binding task-readiness read fresh, so an old approval is never a result.

import { z } from "zod";
import type { RoleContext } from "../job/role-context.ts";
import type { TaskRequest } from "../job/task-request.ts";
import type { Binding } from "../task-result-records.ts";
import { BINDING } from "../task-result-records.ts";
import { opReply } from "./op-replies.ts";

const SHA = z.string().min(1);
// The longest receipt summary a record holds.
const MAX_SUMMARY = 300;
const TASKS = [
  "Sync",
  "Hardening",
  "Integration",
  "Security",
  "Land",
  "Completion",
] as const;

const READY_TASK = z.looseObject({
  task: z.enum(TASKS),
  binding: BINDING,
  status: z.string(),
});

// task-readiness: R, T, whether R contains T, and the next ready task with
// its binding, or why none may run.
const READINESS = z.union([
  z.looseObject({
    revision: z.looseObject({ code: SHA, inputs: SHA, policy: SHA }).nullable(),
    target: z.looseObject({ branch: SHA, commit: SHA }),
    contains: z.boolean(),
    next: READY_TASK,
    hold: z.null(),
  }),
  z.looseObject({
    revision: z.looseObject({ code: SHA, inputs: SHA, policy: SHA }).nullable(),
    target: z.looseObject({ branch: SHA, commit: SHA }),
    contains: z.boolean(),
    next: z.null(),
    hold: z.string().min(1),
  }),
]);

// task-result: one binding's status, and its latest run.
const TASK_STATUS = z.union([
  z.looseObject({
    status: z.enum(["passed", "refused"]),
    result: z.looseObject({
      run: z.looseObject({ id: SHA }),
      receipt: z.looseObject({
        summary: z.string(),
        produced: z.looseObject({ code: SHA }).optional(),
      }),
    }),
    attempts: z.number(),
    latest: SHA.nullable(),
  }),
  z.looseObject({
    status: z.literal("unknown"),
    run: SHA,
    attempts: z.number(),
    latest: SHA.nullable(),
  }),
  z.looseObject({
    status: z.enum(["missing", "exhausted"]),
    attempts: z.number(),
    budget: z.number(),
    latest: SHA.nullable(),
  }),
  z.looseObject({ status: z.literal("held"), reason: z.string() }),
]);

type Readiness = z.infer<typeof READINESS>;
type TaskStatus = z.infer<typeof TASK_STATUS>;
type ReadyTask = z.infer<typeof READY_TASK>;

// A new run of a binding: a fresh identity, linked to the binding's latest
// attempt, so a retry is never the run it follows (`runs-and-retries`).
interface Run {
  id: string;
  previous: string | null;
}

async function readiness(ctx: RoleContext): Promise<Readiness> {
  return await opReply(ctx, "task-readiness", {}, READINESS);
}

async function taskStatus(
  ctx: RoleContext,
  binding: Binding,
): Promise<TaskStatus> {
  return await opReply(ctx, "task-result", { binding }, TASK_STATUS);
}

function newRun(status: TaskStatus): Run {
  let previous: string | null = null;
  if (status.status !== "held") {
    previous = status.latest;
  }
  return { id: crypto.randomUUID(), previous };
}

// Appends the attempt of `run` for `binding`, only while its status is
// missing (the op refuses any other).
async function recordAttempt(
  ctx: RoleContext,
  binding: Binding,
  run: Run,
): Promise<void> {
  await ctx.op("record-task-attempt", { binding, run });
}

// Appends `run`'s verdict for `binding`.
async function recordResult(
  ctx: RoleContext,
  binding: Binding,
  result: {
    run: string;
    verdict: "passed" | "failed" | "refused";
    summary: string;
  },
): Promise<void> {
  await ctx.op("record-task-result", {
    binding,
    run: { id: result.run },
    verdict: result.verdict,
    receipt: { summary: result.summary.slice(0, MAX_SUMMARY) },
  });
}

// The request for a ready task a caller relays: the task and its binding.
function requestOf(next: ReadyTask): TaskRequest | null {
  if (next.task === "Sync" || next.task === "Integration") {
    return { task: next.task, binding: next.binding };
  }
  return null;
}

export type { Readiness, ReadyTask, Run, TaskStatus };
export {
  newRun,
  readiness,
  recordAttempt,
  recordResult,
  requestOf,
  TASK_STATUS,
  taskStatus,
};
