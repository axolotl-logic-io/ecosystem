// The stage job's arguments: a run of one stage of one issue, a print of that
// stage job's boundary, or a steer of a running job's session. Each is
// checked before the job does anything.

import { parseArgs } from "node:util";
import { z } from "zod";
import { STAGE_ORDER } from "../workflow/sweep-config.ts";

const STAGES = STAGE_ORDER.join(", ");
const NO_CONFIG = "--config must name a repo config file";
const NO_ISSUE = "--issue must be an issue number";
const NO_STAGE = `--stage must be one of: ${STAGES}`;
const NO_MESSAGE = "--steer needs a --message";
const STEER_RESUME = "--steer can't be combined with --resume";
const STEER_BOUNDARY = "--steer can't be combined with --print-boundary";
const NO_QUEUE = "--merge-queue must list issue numbers, such as 3,5";
const MERGE_QUEUE = z
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
const ISSUE = z.coerce
  .number({ error: NO_ISSUE })
  .int(NO_ISSUE)
  .positive(NO_ISSUE);
const STAGE = z.enum(STAGE_ORDER, { error: NO_STAGE });
const JOB_ARGS = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    config: CONFIG,
    issue: ISSUE,
    stage: STAGE,
    lane: z.string().optional(),
    resume: z.boolean().optional(),
    // The merge order the orchestrator ranked (#234).
    mergeQueue: MERGE_QUEUE.optional(),
  }),
  z.object({
    kind: z.literal("steer"),
    config: CONFIG,
    issue: ISSUE,
    steer: z.string().min(1),
    message: z.string({ error: NO_MESSAGE }).min(1, NO_MESSAGE),
    resume: z.undefined({ error: STEER_RESUME }).optional(),
    printBoundary: z.undefined({ error: STEER_BOUNDARY }).optional(),
  }),
  z.object({
    kind: z.literal("boundary"),
    config: CONFIG,
    issue: ISSUE,
    stage: STAGE,
  }),
]);

type JobArgs = z.infer<typeof JOB_ARGS>;
type RunArgs = Extract<JobArgs, { kind: "run" }>;
type SteerArgs = Extract<JobArgs, { kind: "steer" }>;
type BoundaryArgs = Extract<JobArgs, { kind: "boundary" }>;

// The job's arguments, or a throw that says which is missing or bad.
function jobArgsOf(argv: readonly string[]): JobArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      issue: { type: "string" },
      stage: { type: "string" },
      lane: { type: "string" },
      resume: { type: "boolean" },
      steer: { type: "string" },
      message: { type: "string" },
      "print-boundary": { type: "boolean" },
      "merge-queue": { type: "string" },
    },
    strict: true,
  });
  const {
    "print-boundary": printBoundary,
    "merge-queue": mergeQueue,
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
    kind,
  });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export type { BoundaryArgs, JobArgs, RunArgs, SteerArgs };
export { jobArgsOf };
