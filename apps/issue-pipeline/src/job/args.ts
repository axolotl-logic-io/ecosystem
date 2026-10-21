// The stage job's arguments: a run of one stage of one issue, a print of that
// stage job's boundary, or a steer of a running job's session. Each is
// checked before the job does anything.

import { parseArgs } from "node:util";
import { z } from "zod";
import { STAGES } from "../stages.ts";

const STAGE_LIST = STAGES.join(", ");
const NO_CONFIG = "--config must name a repo config file";
const NO_ISSUE = "--issue must be an issue number";
const NO_STAGE = `--stage must be one of: ${STAGE_LIST}`;
const NO_MESSAGE = "--steer needs a --message";
const STEER_BOUNDARY = "--steer can't be combined with --print-boundary";
const NO_QUEUE = "--merge-queue must list issue numbers, such as 3,5";
const NO_JOB_ID = "--job-id must be a UUID";
const NO_BRANCH = "--branch must name the issue's branch";
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
// The issue's branch, which the caller assigns: required, never guessed, and
// checked against the repo before the job changes anything (branch.ts).
const BRANCH = z.string({ error: NO_BRANCH }).min(1, NO_BRANCH);
const ISSUE = z.coerce
  .number({ error: NO_ISSUE })
  .int(NO_ISSUE)
  .positive(NO_ISSUE);
const STAGE = z.enum(STAGES, { error: NO_STAGE });
const JOB_ARGS = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    config: CONFIG,
    issue: ISSUE,
    stage: STAGE,
    branch: BRANCH,
    // The claimant's name its lease records; the job's own without one.
    lane: z.string().optional(),
    // The merge order the orchestrator ranked (#234).
    mergeQueue: MERGE_QUEUE.optional(),
    // The job's id, as the orchestrator logs its start; a job started
    // without one makes its own.
    jobId: z.uuid({ error: NO_JOB_ID }).optional(),
  }),
  z.object({
    kind: z.literal("steer"),
    config: CONFIG,
    issue: ISSUE,
    steer: z.string().min(1),
    message: z.string({ error: NO_MESSAGE }).min(1, NO_MESSAGE),
    printBoundary: z.undefined({ error: STEER_BOUNDARY }).optional(),
  }),
  z.object({
    kind: z.literal("boundary"),
    config: CONFIG,
    issue: ISSUE,
    stage: STAGE,
    branch: BRANCH,
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
      branch: { type: "string" },
      lane: { type: "string" },
      steer: { type: "string" },
      message: { type: "string" },
      "print-boundary": { type: "boolean" },
      "merge-queue": { type: "string" },
      "job-id": { type: "string" },
    },
    strict: true,
  });
  const {
    "print-boundary": printBoundary,
    "merge-queue": mergeQueue,
    "job-id": jobId,
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
    kind,
  });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export type { BoundaryArgs, JobArgs, RunArgs, SteerArgs };
export { jobArgsOf };
