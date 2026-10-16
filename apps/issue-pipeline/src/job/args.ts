// The stage job's arguments: a run of one stage of one issue, or a steer of
// a running job's session. Each is checked before the job does anything.

import { parseArgs } from "node:util";
import { z } from "zod";
import { STAGE_ORDER } from "../workflow/sweep-config.ts";

const STAGES = STAGE_ORDER.join(", ");
const NO_CONFIG = "--config must name a repo config file";
const NO_ISSUE = "--issue must be an issue number";
const NO_STAGE = `--stage must be one of: ${STAGES}`;
const NO_MESSAGE = "--steer needs a --message";
const STEER_RESUME = "--steer can't be combined with --resume";
const CONFIG = z.string({ error: NO_CONFIG }).min(1, NO_CONFIG);
const ISSUE = z.coerce
  .number({ error: NO_ISSUE })
  .int(NO_ISSUE)
  .positive(NO_ISSUE);
const JOB_ARGS = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    config: CONFIG,
    issue: ISSUE,
    stage: z
      .string({ error: NO_STAGE })
      .refine(
        (stage: string): boolean => STAGE_ORDER.some((name) => name === stage),
        { message: NO_STAGE },
      ),
    lane: z.string().optional(),
    resume: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("steer"),
    config: CONFIG,
    issue: ISSUE,
    steer: z.string().min(1),
    message: z.string({ error: NO_MESSAGE }).min(1, NO_MESSAGE),
    resume: z.undefined({ error: STEER_RESUME }).optional(),
  }),
]);

type JobArgs = z.infer<typeof JOB_ARGS>;
type RunArgs = Extract<JobArgs, { kind: "run" }>;
type SteerArgs = Extract<JobArgs, { kind: "steer" }>;

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
    },
    strict: true,
  });
  let kind = "run";
  if (values.steer !== undefined) {
    kind = "steer";
  }
  const parsed = JOB_ARGS.safeParse({ ...values, kind });
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

export type { JobArgs, RunArgs, SteerArgs };
export { jobArgsOf };
