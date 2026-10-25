// The stage job's arguments: a run of one stage of one issue, or of one
// task requested for it (`--task` with its `--binding`, task-request.ts), a
// print of that job's boundary, or a steer of a running job's session. Each
// is checked before the job does anything.

import { parseArgs } from "node:util";
import { z } from "zod";
import type { Stage } from "../stages.ts";
import { STAGES } from "../stages.ts";
import { HARDENING_BUDDIES } from "./roles.ts";
import type { JobTask, TaskRequest } from "./task-request.ts";
import { JOB_TASKS, TASK_STAGES, taskRequestOf } from "./task-request.ts";

const STAGE_LIST = STAGES.join(", ");
const NO_CONFIG = "--config must name a repo config file";
const NO_ISSUE = "--issue must be an issue number";
const NO_STAGE = `--stage must be one of: ${STAGE_LIST}`;
const NO_MESSAGE = "--steer needs a --message";
const STEER_BOUNDARY = "--steer can't be combined with --print-boundary";
const STEER_BUDDY = "--steer can't be combined with --hardening-buddy";
const NO_QUEUE = "--merge-queue must list issue numbers, such as 3,5";
const NO_JOB_ID = "--job-id must be a UUID";
const NO_BRANCH = "--branch must name the issue's branch";
const NO_BUDDY = `--hardening-buddy must be one of: ${HARDENING_BUDDIES.join(", ")}`;
const BUDDY_STAGE = "--hardening-buddy applies only to --stage review";
const NO_TASK = `--task must be one of: ${JOB_TASKS.join(", ")}`;
const TASK_BINDING = "--task and --binding go together";
const TASK_BUDDY = "--hardening-buddy can't be combined with --task";
const TASK_QUEUE = "--merge-queue can't be combined with --task";
const LANDING_ORDER = z
  .string()
  .transform((list: string): string[] => list.split(","))
  .pipe(
    z.array(
      z.coerce
        .number<string>({ error: NO_QUEUE })
        .int(NO_QUEUE)
        .positive(NO_QUEUE),
    ),
  );
const CONFIG = z.string({ error: NO_CONFIG }).min(1, NO_CONFIG);
// The issue's branch, which the caller assigns: required, never guessed, and
// checked against the repo before the job changes anything (branch.ts).
const BRANCH = z.string({ error: NO_BRANCH }).min(1, NO_BRANCH);
const ISSUE = z.coerce
  .number({ error: NO_ISSUE })
  .int(NO_ISSUE)
  .positive(NO_ISSUE);
const STAGE = z.enum(STAGES, { error: NO_STAGE });
// Who performs the review stage's Hardening (stageAgentOf in roles.ts). The
// installed caller never passes it, so its jobs harden as "lawd", as before.
const HARDENING = z.enum(HARDENING_BUDDIES, { error: NO_BUDDY }).optional();
// A task requested for the issue (task-request.ts): its name, and its
// binding as JSON, parsed once the arguments are.
const TASK = z.enum(JOB_TASKS, { error: NO_TASK }).optional();
const BINDING_JSON = z.string().min(1).optional();
const JOB_ARGS = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("run"),
      config: CONFIG,
      issue: ISSUE,
      stage: STAGE,
      branch: BRANCH,
      // The claimant's name its lease records; the job's own without one.
      lane: z.string().optional(),
      // The landing order the caller ranked (#234).
      mergeQueue: LANDING_ORDER.optional(),
      // The job's id, as the caller logs its start; a job started
      // without one makes its own.
      jobId: z.uuid({ error: NO_JOB_ID }).optional(),
      hardeningBuddy: HARDENING,
      task: TASK,
      binding: BINDING_JSON,
      // Started for an assignment (#119): the buddy's grant must hold.
      assignment: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal("steer"),
      config: CONFIG,
      issue: ISSUE,
      steer: z.string().min(1),
      message: z.string({ error: NO_MESSAGE }).min(1, NO_MESSAGE),
      printBoundary: z.undefined({ error: STEER_BOUNDARY }).optional(),
      hardeningBuddy: z.undefined({ error: STEER_BUDDY }).optional(),
    }),
    z.object({
      kind: z.literal("boundary"),
      config: CONFIG,
      issue: ISSUE,
      stage: STAGE,
      branch: BRANCH,
      hardeningBuddy: HARDENING,
      task: TASK,
      binding: BINDING_JSON,
    }),
  ])
  .refine(
    (args) =>
      args.kind === "steer" ||
      (args.hardeningBuddy ?? "lawd") === "lawd" ||
      args.stage === "review",
    { error: BUDDY_STAGE },
  )
  .refine(
    (args) =>
      args.kind === "steer" ||
      (args.task === undefined) === (args.binding === undefined),
    { error: TASK_BINDING },
  )
  .refine(
    (args) =>
      args.kind === "steer" ||
      args.task === undefined ||
      args.hardeningBuddy === undefined,
    { error: TASK_BUDDY },
  )
  .refine(
    (args) =>
      args.kind !== "run" ||
      args.task === undefined ||
      args.mergeQueue === undefined,
    { error: TASK_QUEUE },
  );

type ParsedArgs = z.infer<typeof JOB_ARGS>;
type Parsed<K> = Omit<Extract<ParsedArgs, { kind: K }>, "task" | "binding">;
// A run or boundary's task request, parsed from its --task and --binding.
type WithTask<T> = T & { task: (TaskRequest & { name: JobTask }) | null };
type RunArgs = WithTask<Parsed<"run">>;
type SteerArgs = Extract<ParsedArgs, { kind: "steer" }>;
type BoundaryArgs = WithTask<Parsed<"boundary">>;
type JobArgs = RunArgs | SteerArgs | BoundaryArgs;

// The task request `--task` and `--binding` make, or a throw that says why
// they don't: a binding for another task, or a task at a stage it can't run.
function requestOf(
  stage: Stage,
  task: JobTask | undefined,
  binding: string | undefined,
): (TaskRequest & { name: JobTask }) | null {
  if (task === undefined || binding === undefined) {
    return null;
  }
  if (!TASK_STAGES[task].includes(stage)) {
    throw new Error(
      `--task ${task} runs at --stage ${TASK_STAGES[task].join(" or ")}, not ${stage}`,
    );
  }
  return { name: task, ...taskRequestOf(task, binding) };
}

// The job's arguments, or a throw that says which is missing or bad.
function jobArgsOf(argv: readonly string[]): JobArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      issue: { type: "string" },
      stage: { type: "string" },
      branch: { type: "string" },
      lane: { type: "string" },
      steer: { type: "string" },
      message: { type: "string" },
      "print-boundary": { type: "boolean" },
      "merge-queue": { type: "string" },
      "job-id": { type: "string" },
      "hardening-buddy": { type: "string" },
      task: { type: "string" },
      binding: { type: "string" },
      assignment: { type: "boolean" },
    },
    strict: true,
  });
  const {
    "print-boundary": printBoundary,
    "merge-queue": mergeQueue,
    "job-id": jobId,
    "hardening-buddy": hardeningBuddy,
    ...named
  } = values;
  let kind = "run";
  if (named.steer !== undefined) {
    kind = "steer";
  } else if (printBoundary === true) {
    kind = "boundary";
  }
  const parsed = JOB_ARGS.safeParse({
    ...named,
    printBoundary,
    mergeQueue,
    jobId,
    hardeningBuddy,
    kind,
  });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  const args = parsed.data;
  if (args.kind === "steer") {
    return args;
  }
  const { task, binding, ...rest } = args;
  return { ...rest, task: requestOf(args.stage, task, binding) };
}

export type { BoundaryArgs, JobArgs, RunArgs, SteerArgs };
export { jobArgsOf };
