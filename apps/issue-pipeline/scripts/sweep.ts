#!/usr/bin/env node

// The opt-in assignment sweep (#120): one pass over each configured repo,
// starting the work its assignments grant through the caller's own
// launcher (caller-jobs/start.ts), so every cap, attempt limit and
// exclusion of the run folder applies. build.ts bundles it and install.mjs
// installs it as $ISSUE_PIPELINE_ROOT/sweep.mjs:
//
//   node sweep.mjs --run RUN_DIR --config CONFIG [--config CONFIG …]
//        --lane LANE
//
// Only a repo whose config names `assignments.grantor` takes part. Each
// sweep prints one JSON line per decision (sweep/plan.ts): a start, with
// its stage or task and receipt, or a hold and why. It exits 0 after the
// sweep, 1 on an error. It never waits for a job and never kills one.
// See docs/reference/assignment-sweep.md.

import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { parsed, runLimits } from "./caller-jobs/run-limits.ts";
import { sweepRepo } from "./sweep/plan.ts";

const SWEEP_ARGS = z.object({
  run: z.string().min(1),
  config: z.array(z.string().min(1)).min(1),
  lane: z.string().min(1),
});

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function main(argv: readonly string[]): 0 | 1 {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        run: { type: "string" },
        config: { type: "string", multiple: true },
        lane: { type: "string" },
      },
      strict: true,
    });
    const args = parsed(SWEEP_ARGS, values, "sweep");
    runLimits(args.run);
    for (const config of args.config) {
      for (const decision of sweepRepo({ ...args, config })) {
        process.stdout.write(`${JSON.stringify(decision)}\n`);
      }
    }
    return 0;
  } catch (error: unknown) {
    process.stderr.write(`sweep: ${messageOf(error)}\n`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
