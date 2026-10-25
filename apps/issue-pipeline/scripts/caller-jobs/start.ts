// One job start, after every check the launcher makes (caller-jobs.ts):
// the run's caps and exclusions, the stage or task's attempts, live jobs on
// the issue, branch or repo's merge, a task request's binding, and an issue
// GitHub doesn't show open. Both the caller's `start` and the assignment
// sweep (sweep.ts) start jobs only through here, so neither bypasses a cap
// the other counts. A refused start throws Refusal, with the reason.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { childEnvironment } from "../../src/child-env.ts";
import { loadConfig } from "../../src/config.ts";
import { issueState } from "../../src/github.ts";
import type { JobTask, TaskRequest } from "../../src/job/task-request.ts";
import {
  JOB_TASKS,
  requestRefusalOf,
  TASK_STAGES,
  taskRequestOf,
} from "../../src/job/task-request.ts";
import { ROOT } from "../../src/pipeline-root.ts";
import type { Stage } from "../../src/stages.ts";
import { STAGES } from "../../src/stages.ts";
import { JOB_ENTRY, liveJobs, refusalOf } from "./live-jobs.ts";
import type { Launch } from "./run-folder.ts";
import { attemptsAt, launches, newReceipt, writeLaunch } from "./run-folder.ts";
import type { RunLimits } from "./run-limits.ts";
import { runLimits, wideningOf } from "./run-limits.ts";

const START_ARGS = z.object({
  run: z.string().min(1),
  config: z.string().min(1),
  issue: z.coerce.number().int().positive(),
  branch: z.string().min(1),
  lane: z.string().min(1),
  stage: z.enum(STAGES),
  mergeQueue: z.string().optional(),
  task: z.enum(JOB_TASKS).optional(),
  binding: z.string().min(1).optional(),
  // A start for an assignment (#119): the job checks its buddy's grant.
  assignment: z.boolean().optional(),
});

type StartArgs = z.infer<typeof START_ARGS>;

class Refusal extends Error {}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// The task `args` request, or null for a stage job; a throw for a request
// that isn't whole or isn't for this task at this stage.
function requestOf(args: StartArgs): TaskRequest | null {
  const { task, binding } = args;
  if (task === undefined && binding === undefined) {
    return null;
  }
  if (task === undefined || binding === undefined) {
    throw new Refusal("--task and --binding go together");
  }
  if (!TASK_STAGES[task].includes(args.stage)) {
    throw new Refusal(
      `--task ${task} runs at --stage ${TASK_STAGES[task].join(" or ")}, not ${args.stage}`,
    );
  }
  try {
    return taskRequestOf(task, binding);
  } catch (error: unknown) {
    throw new Refusal(messageOf(error), { cause: error });
  }
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
  if (args.task !== undefined && args.binding !== undefined) {
    argv.push("--task", args.task, "--binding", args.binding);
  } else if (args.stage === "review") {
    argv.push("--hardening-buddy", "hippy");
  }
  if (args.assignment === true) {
    argv.push("--assignment");
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

// A task launch's task and binding, as its receipt records them.
function taskOf(
  args: StartArgs,
  request: TaskRequest | null,
): Pick<Launch, "task" | "binding"> {
  if (args.task === undefined || request === null) {
    return {};
  }
  return { task: args.task, binding: request.binding };
}

// Starts the job `args` asks for, after every check, and gives its launch
// with its receipt folder; throws Refusal for a start the checks refuse.
function startJob(args: StartArgs): Launch & { receipt: string } {
  const request = requestOf(args);
  const limits = runLimits(args.run);
  const widening = wideningOf(args.run, limits);
  if (widening !== null) {
    throw new Refusal(widening);
  }
  const nodeFlags = nodeFlagsOf(limits);
  const cfg = loadConfig(args.config);
  const { issue, stage, branch, lane } = args;
  if (request !== null) {
    const misbound = requestRefusalOf(cfg, issue, request);
    if (misbound !== null && misbound !== "") {
      throw new Refusal(misbound);
    }
  }
  const work: Stage | JobTask = args.task ?? stage;
  const where = { slug: cfg.slug, issue, work };
  const attempt = attemptsAt(args.run, where) + 1;
  const live = liveJobs(launches(args.run));
  const refusal = refusalOf(
    limits,
    { cfg, issue, stage, work, branch, attempt },
    live,
  );
  if (refusal !== null) {
    throw new Refusal(refusal);
  }
  const state = issueState(cfg, issue);
  const recovery = state === "closed" && work === "merge";
  if (state !== "open" && !recovery) {
    throw new Refusal(`GitHub shows #${issue} as ${state ?? "unreadable"}`);
  }
  const receipt = newReceipt(args.run, where);
  const jobId = randomUUID();
  const jobArgs = jobArgv(args, jobId);
  const pid = spawnJob(jobArgs, receipt, nodeFlags);
  const launch: Launch = {
    repo: cfg.repo,
    slug: cfg.slug,
    issue,
    stage,
    ...taskOf(args, request),
    branch,
    lane,
    attempt: receipt.attempt,
    jobId,
    pid,
    startedAt: new Date().toISOString(),
    argv: jobArgs,
  };
  writeLaunch(receipt, launch);
  return { receipt: receipt.dir, ...launch };
}

export type { StartArgs };
export { Refusal, START_ARGS, startJob };
