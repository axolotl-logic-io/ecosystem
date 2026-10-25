#!/usr/bin/env node

// The opt-in assignment sweep (#120): one pass over each configured repo,
// starting the work its assignments grant through the caller's own
// launcher (caller-jobs/start.ts), so every cap, attempt limit and
// exclusion of the run folder applies. build.ts bundles it and install.ts
// installs it as $ISSUE_PIPELINE_ROOT/sweep.mjs:
//
//   node sweep.mjs --run RUN_DIR --config CONFIG [--config CONFIG …]
//        --lane LANE [--sweeps N] [--interval SECONDS]
//
// Repeat mode (#174) runs N sweeps (1 to 1000, default 1) with an idle wait
// of SECONDS (0 to 3600, default 60) between them, then exits. SIGTERM or
// SIGINT ends it at the next sweep's start or during the wait; a sweep
// under way finishes first, and no job it started is touched. Every sweep
// reads GitHub afresh: holds a blocked job recorded (src/assignment/hold.ts),
// pauses, stops and live jobs keep it from starting the same work twice,
// across restarts too.
//
// Only a repo whose config names `assignments.grantor` takes part. Each
// sweep prints one JSON line per decision (sweep/plan.ts): a start, with
// its stage or task and receipt, or a hold and why. It exits 0 after the
// sweep, 1 on an error. It never waits for a job and never kills one.
// See docs/reference/assignment-sweep.md.

import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { parsed, runLimits } from "./caller-jobs/run-limits.ts";
import { sweepRepo } from "./sweep/plan.ts";

const MAX_SWEEPS = 1000;
const MAX_INTERVAL_SECONDS = 3600;
const DEFAULT_INTERVAL_SECONDS = 60;
const MS_PER_SECOND = 1000;
const SWEEP_ARGS = z.object({
  run: z.string().min(1),
  config: z.array(z.string().min(1)).min(1),
  lane: z.string().min(1),
  sweeps: z.coerce.number().int().min(1).max(MAX_SWEEPS).default(1),
  interval: z.coerce
    .number()
    .int()
    .min(0)
    .max(MAX_INTERVAL_SECONDS)
    .default(DEFAULT_INTERVAL_SECONDS),
});

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// One sweep of every configured repo, each decision printed as a line.
function sweepOnce(args: z.infer<typeof SWEEP_ARGS>, sweep: number): void {
  for (const config of args.config) {
    for (const decision of sweepRepo({ ...args, config })) {
      process.stdout.write(`${JSON.stringify({ sweep, ...decision })}\n`);
    }
  }
}

// Sweeps `sweep` to the last, waiting the interval before each but the
// first, until `stopped` aborts.
async function sweepsFrom(
  args: z.infer<typeof SWEEP_ARGS>,
  sweep: number,
  stopped: AbortSignal,
): Promise<void> {
  if (sweep > args.sweeps || stopped.aborted) {
    return;
  }
  if (sweep > 1) {
    await delay(args.interval * MS_PER_SECOND, null, { signal: stopped }).catch(
      () => null,
    );
    if (stopped.aborted) {
      return;
    }
  }
  sweepOnce(args, sweep);
  await sweepsFrom(args, sweep + 1, stopped);
}

async function main(argv: readonly string[]): Promise<0 | 1> {
  const stopping = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => stopping.abort());
  }
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        run: { type: "string" },
        config: { type: "string", multiple: true },
        lane: { type: "string" },
        sweeps: { type: "string" },
        interval: { type: "string" },
      },
      strict: true,
    });
    const args = parsed(SWEEP_ARGS, values, "sweep");
    runLimits(args.run);
    await sweepsFrom(args, 1, stopping.signal);
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`sweep: ${messageOf(error)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
