#!/usr/bin/env node

// The pipeline caller's one launcher (docs/reference/caller.md): it starts
// stage jobs detached, after its checks, and reports how they stand, so a
// caller never builds its own wrapper or polls in a loop. build.ts bundles it
// and install.ts installs it as $ISSUE_PIPELINE_ROOT/caller-jobs.mjs:
//
//   node caller-jobs.mjs start  --run RUN_DIR --config CONFIG --issue N
//        --branch BRANCH --lane LANE --stage STAGE [--landing-order N1,N2]
//        [--task sync|integration --binding JSON]
//   node caller-jobs.mjs status --run RUN_DIR
//   node caller-jobs.mjs wait   --run RUN_DIR --seconds S
//
// `start` refuses (exit 2, the reason on stderr) a run.json rewritten to
// widen the caps the run's first start read (wideningOf in
// caller-jobs/run-limits.ts), what refusalOf in caller-jobs/live-jobs.ts
// refuses, and an issue GitHub doesn't show open, except an explicit Land
// attempt on a closed issue. The job's canonical claim guards alone decide
// closed recovery eligibility and reopen only for the winning claimant.
// Otherwise it runs the installed job.mjs in its own session with its stdin
// closed, prints the receipt as one JSON line and exits without waiting
// (caller-jobs/start.ts, which the assignment sweep starts jobs through too).
// Every review start hardens as Hippy (`--hardening-buddy hippy`,
// `two-buddies`).
//
// A task request (#186) is `--task` with `--binding`, the task and binding
// exactly as a job's `request` printed them; the launcher relays it and
// decides nothing about readiness. It refuses, before anything starts, a
// binding for another task, issue, repository or target branch, a task at a
// stage it can't run at, and a task on a closed issue. A task job counts
// under every cap, exclusion and attempt limit, with its task as its stage.
//
// `status` prints one JSON line per job the run started; a task job's line
// adds `taskState`: running, completed (a determined verdict), held or
// unknown (it ended with no verdict), never completed for those last two.
// `wait` blocks until a job has ended that no report has shown yet, or S
// seconds pass, prints {"waited": "ended", "timeout" or "idle"}, then the
// same lines as status. Other errors exit 1.
//
// The launcher reads no credential. GitHub tokens stay with the pipeline's
// own loader (the config's credentialsEnvFile); the run's modelEnvFile is
// passed to Node's --env-file by path, so only the job's process reads it,
// into the variables runtime.credentialEnv names. Only run.json names that
// file, by path; receipts and output don't.

import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { landingOrderFlag } from "../src/job/landing-order-flag.ts";
import { sleepMs } from "../src/process.ts";
import type { JobReport } from "./caller-jobs/run-folder.ts";
import { pending, reports } from "./caller-jobs/run-folder.ts";
import { parsed, runLimits } from "./caller-jobs/run-limits.ts";
import { Refusal, START_ARGS, startJob } from "./caller-jobs/start.ts";

const WAIT_STEP_MS = 2000;
const MS_PER_SECOND = 1000;
const MAX_WAIT_SECONDS = 3600;
const SUCCEEDED = 0;
const FAILED = 1;
const REFUSED = 2;

const RUN_ARGS = z.object({ run: z.string().min(1) });
const WAIT_ARGS = z.object({
  run: z.string().min(1),
  seconds: z.coerce.number().int().min(1).max(MAX_WAIT_SECONDS),
});

// Why wait returned: a job ended that no report had shown, the time ran
// out, or none ran.
type Waited = "ended" | "timeout" | "idle";
type ExitCode = typeof SUCCEEDED | typeof FAILED | typeof REFUSED;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function start(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      run: { type: "string" },
      config: { type: "string" },
      issue: { type: "string" },
      branch: { type: "string" },
      lane: { type: "string" },
      stage: { type: "string" },
      "landing-order": { type: "string" },
      "merge-queue": { type: "string" },
      task: { type: "string" },
      binding: { type: "string" },
    },
    strict: true,
  });
  const {
    "landing-order": landingOrder,
    "merge-queue": mergeQueue,
    ...named
  } = values;
  const order = landingOrderFlag({
    "landing-order": landingOrder,
    "merge-queue": mergeQueue,
  });
  const args = parsed(START_ARGS, { ...named, landingOrder: order }, "start");
  process.stdout.write(`${JSON.stringify(startJob(args))}\n`);
}

function printReports(jobs: readonly JobReport[]): void {
  for (const job of jobs) {
    process.stdout.write(`${JSON.stringify(job)}\n`);
  }
}

function status(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: { run: { type: "string" } },
    strict: true,
  });
  const { run } = parsed(RUN_ARGS, values, "status");
  runLimits(run);
  printReports(reports(run));
}

// Waits until a job has ended that no report has shown, or `seconds` pass.
function waitFor(runDir: string, seconds: number): Waited {
  const deadline = Date.now() + seconds * MS_PER_SECOND;
  for (;;) {
    const { unreported, running } = pending(runDir);
    if (unreported) {
      return "ended";
    }
    if (!running) {
      return "idle";
    }
    if (Date.now() >= deadline) {
      return "timeout";
    }
    sleepMs(Math.min(WAIT_STEP_MS, deadline - Date.now()));
  }
}

function wait(argv: readonly string[]): void {
  const { values } = parseArgs({
    args: [...argv],
    options: { run: { type: "string" }, seconds: { type: "string" } },
    strict: true,
  });
  const { run, seconds } = parsed(WAIT_ARGS, values, "wait");
  runLimits(run);
  const waited = waitFor(run, seconds);
  process.stdout.write(`${JSON.stringify({ waited })}\n`);
  printReports(reports(run));
}

const COMMANDS: ReadonlyMap<string, (argv: readonly string[]) => void> =
  new Map([
    ["start", start],
    ["status", status],
    ["wait", wait],
  ]);

function main(argv: readonly string[]): ExitCode {
  const [name = "", ...rest] = argv;
  const command = COMMANDS.get(name);
  if (command === undefined) {
    process.stderr.write("caller-jobs: give start, status or wait\n");
    return FAILED;
  }
  try {
    command(rest);
    return SUCCEEDED;
  } catch (error: unknown) {
    if (error instanceof Refusal) {
      process.stderr.write(`caller-jobs: refused: ${error.message}\n`);
      return REFUSED;
    }
    process.stderr.write(`caller-jobs: ${messageOf(error)}\n`);
    return FAILED;
  }
}

process.exitCode = main(process.argv.slice(2));
