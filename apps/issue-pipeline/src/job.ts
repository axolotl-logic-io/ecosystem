#!/usr/bin/env node
// The stage job: one sweep pinned to one issue that begins only one stage.
//
//   node job.mjs --config <path> --issue N --stage <stage> [--lane L]
//
// It claims #N, begins only <stage> (an issue saved at another stage is
// released untouched as "wrong-stage"), then closes parents, releases or
// posts, and cleans up as a sweep does. Each batch the sweep's driver asks
// for runs in parallel, up to the config's spawn cap: ops requests run the
// installed ops.mjs and model sessions run `pi` (src/job/launch.ts). It prints
// the sweep's summary as one JSON line and exits 0, even when the stage stops
// the issue; it exits 1, with the reason on stderr, only when the job itself
// fails: bad arguments, a config loadConfig refuses, or a failed sweep op.

import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadConfig, paths } from "./config.ts";
import { runLaunch } from "./job/launch.ts";
import { runAll } from "./job/pool.ts";
import type { LaunchSpec } from "./workflow/launches.ts";
import type { SweepSummary } from "./workflow/stages/types.ts";
import { startSweep } from "./workflow/sweep.ts";
import { STAGE_ORDER, spawnLimitOf } from "./workflow/sweep-config.ts";

const STAGES = STAGE_ORDER.join(", ");
// A sweep's id is "s" and the start time in base 36, as workflow.js makes it.
const SWEEP_ID_RADIX = 36;
const NO_CONFIG = "--config must name a repo config file";
const NO_ISSUE = "--issue must be an issue number";
const NO_STAGE = `--stage must be one of: ${STAGES}`;
const JOB_ARGS = z.object({
  config: z.string({ error: NO_CONFIG }).min(1, NO_CONFIG),
  issue: z.coerce.number({ error: NO_ISSUE }).int(NO_ISSUE).positive(NO_ISSUE),
  stage: z
    .string({ error: NO_STAGE })
    .refine(
      (stage: string): boolean => STAGE_ORDER.some((name) => name === stage),
      { message: NO_STAGE },
    ),
  lane: z.string().optional(),
});
const SPAWN_CAP = z.number().nullish().catch(null);

type JobArgs = z.infer<typeof JOB_ARGS>;

// The job's arguments, or a throw that says which is missing or bad.
function jobArgsOf(argv: readonly string[]): JobArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      config: { type: "string" },
      issue: { type: "string" },
      stage: { type: "string" },
      lane: { type: "string" },
    },
    strict: true,
  });
  const parsed = JOB_ARGS.safeParse(values);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
}

async function runJob(argv: readonly string[]): Promise<SweepSummary> {
  const args = jobArgsOf(argv);
  const cfg = loadConfig(args.config);
  const { maxSpawnsPerRun } = cfg;
  const limit = spawnLimitOf(SPAWN_CAP.parse(maxSpawnsPerRun));
  function sessionFile(key: string): string {
    return paths.session(cfg, args.issue, key);
  }
  const sweep = startSweep(args, {
    sweepId: `s${Date.now().toString(SWEEP_ID_RADIX)}`,
    now: (): Date => new Date(),
  });
  // Runs each batch the sweep asks for, feeding its results back, until the
  // sweep asks for none.
  async function drive(specs: readonly LaunchSpec[]): Promise<void> {
    if (specs.length === 0) {
      return;
    }
    const results = await runAll(specs, limit, (spec: LaunchSpec) =>
      runLaunch(spec, sessionFile),
    );
    await drive(sweep.next(results));
  }
  await drive(sweep.next([]));
  return sweep.summary();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function main(): Promise<void> {
  try {
    const summary = await runJob(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error: unknown) {
    process.stderr.write(`job: ${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
