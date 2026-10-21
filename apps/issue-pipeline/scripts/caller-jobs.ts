#!/usr/bin/env node

// The pipeline caller's one launcher (docs/reference/caller.md): it starts
// stage jobs detached, after its checks, and reports how they stand, so a
// caller never builds its own wrapper or polls in a loop. build.ts bundles it
// and install.mjs installs it as $ISSUE_PIPELINE_ROOT/caller-jobs.mjs:
//
//   node caller-jobs.mjs start  --run RUN_DIR --config CONFIG --issue N
//        --branch BRANCH --lane LANE --stage STAGE [--merge-queue N1,N2]
//   node caller-jobs.mjs status --run RUN_DIR
//   node caller-jobs.mjs wait   --run RUN_DIR --seconds S
//
// `start` refuses (exit 2, the reason on stderr) a run.json rewritten to
// widen the caps the run's first start read (wideningOf in
// caller-jobs/run-limits.ts), what refusalOf in caller-jobs/live-jobs.ts
// refuses, and an issue GitHub doesn't show open.
// Otherwise it runs the installed job.mjs in its own session with its stdin
// closed, prints the receipt as one JSON line and exits without waiting.
// `status` prints one JSON line per job the run started. `wait` blocks until
// a job has ended that no report has shown yet, or S seconds pass, prints
// {"waited": "ended", "timeout" or "idle"}, then the same lines as status.
// Other errors exit 1.
//
// The launcher reads no credential. GitHub tokens stay with the pipeline's
// own loader (the config's credentialsEnvFile); the run's modelEnvFile is
// passed to Node's --env-file by path, so only the job's process reads it,
// into the variables runtime.credentialEnv names. Only run.json names that
// file, by path; receipts and output don't.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { childEnvironment } from "../src/child-env.ts";
import { loadConfig } from "../src/config.ts";
import { issueState } from "../src/github.ts";
import { ROOT } from "../src/pipeline-root.ts";
import { sleepMs } from "../src/process.ts";
import { STAGES } from "../src/stages.ts";
import { JOB_ENTRY, liveJobs, refusalOf } from "./caller-jobs/live-jobs.ts";
import type { JobReport, Launch } from "./caller-jobs/run-folder.ts";
import {
  attemptsAt,
  launches,
  newReceipt,
  pending,
  reports,
  writeLaunch,
} from "./caller-jobs/run-folder.ts";
import type { RunLimits } from "./caller-jobs/run-limits.ts";
import { parsed, runLimits, wideningOf } from "./caller-jobs/run-limits.ts";

const WAIT_STEP_MS = 2000;
const MS_PER_SECOND = 1000;
const MAX_WAIT_SECONDS = 3600;
const SUCCEEDED = 0;
const FAILED = 1;
const REFUSED = 2;

const START_ARGS = z.object({
  run: z.string().min(1),
  config: z.string().min(1),
  issue: z.coerce.number().int().positive(),
  branch: z.string().min(1),
  lane: z.string().min(1),
  stage: z.enum(STAGES),
  mergeQueue: z.string().optional(),
});
const RUN_ARGS = z.object({ run: z.string().min(1) });
const WAIT_ARGS = z.object({
  run: z.string().min(1),
  seconds: z.coerce.number().int().min(1).max(MAX_WAIT_SECONDS),
});

type StartArgs = z.infer<typeof START_ARGS>;
// Why wait returned: a job ended that no report had shown, the time ran
// out, or none ran.
type Waited = "ended" | "timeout" | "idle";
type ExitCode = typeof SUCCEEDED | typeof FAILED | typeof REFUSED;

class Refusal extends Error {}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function jobArgv(args: StartArgs, jobId: string): string[] {
  const argv = [
    path.join(ROOT, JOB_ENTRY),
    "--config",
    path.resolve(args.config),
    "--issue",
    String(args.issue),
    "--branch",
    args.branch,
    "--lane",
    args.lane,
    "--stage",
    args.stage,
    "--job-id",
    jobId,
  ];
  if (args.mergeQueue !== undefined) {
    argv.push("--merge-queue", args.mergeQueue);
  }
  return argv;
}

// Node's flags for the job: --env-file with the run's model key file, which
// is checked to be a file by its metadata alone. Only the job opens it.
function nodeFlagsOf(limits: RunLimits): string[] {
  const file = limits.modelEnvFile;
  if (file === undefined) {
    return [];
  }
  if (fs.statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    throw new Error(`modelEnvFile ${file} is not a file`);
  }
  return [`--env-file=${file}`];
}

// Starts job.mjs in its own session, writing to `stdout` and `stderr`, and
// gives its pid. The launcher doesn't wait for it.
function spawnJob(
  argv: readonly string[],
  output: { stdout: string; stderr: string },
  nodeFlags: readonly string[],
): number {
  const out = fs.openSync(output.stdout, "a");
  const err = fs.openSync(output.stderr, "a");
  try {
    const child = spawn(process.execPath, [...nodeFlags, ...argv], {
      cwd: ROOT,
      env: childEnvironment(process.env),
      detached: true,
      stdio: ["ignore", out, err],
    });
    child.on("error", (error: Error): void => {
      process.stderr.write(`caller-jobs: ${JOB_ENTRY}: ${error.message}\n`);
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error(`could not start ${JOB_ENTRY}`);
    }
    return child.pid;
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
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
      "merge-queue": { type: "string" },
    },
    strict: true,
  });
  const { "merge-queue": mergeQueue, ...named } = values;
  const args = parsed(START_ARGS, { ...named, mergeQueue }, "start");
  const limits = runLimits(args.run);
  const widening = wideningOf(args.run, limits);
  if (widening !== null) {
    throw new Refusal(widening);
  }
  const nodeFlags = nodeFlagsOf(limits);
  const cfg = loadConfig(args.config);
  const { issue, stage, branch, lane } = args;
  const where = { slug: cfg.slug, issue, stage };
  const attempt = attemptsAt(args.run, where) + 1;
  const live = liveJobs(launches(args.run));
  const refusal = refusalOf(
    limits,
    { cfg, issue, stage, branch, attempt },
    live,
  );
  if (refusal !== null) {
    throw new Refusal(refusal);
  }
  const state = issueState(cfg, issue);
  if (state !== "open") {
    throw new Refusal(`GitHub shows #${issue} as ${state ?? "unreadable"}`);
  }
  const receipt = newReceipt(args.run, where);
  const jobId = randomUUID();
  const jobArgs = jobArgv(args, jobId);
  const pid = spawnJob(jobArgs, receipt, nodeFlags);
  const launch: Launch = {
    repo: cfg.repo,
    ...where,
    branch,
    lane,
    attempt: receipt.attempt,
    jobId,
    pid,
    startedAt: new Date().toISOString(),
    argv: jobArgs,
  };
  writeLaunch(receipt, launch);
  process.stdout.write(
    `${JSON.stringify({ receipt: receipt.dir, ...launch })}\n`,
  );
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
