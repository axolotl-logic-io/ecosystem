// Task requests (#186): a task and the exact binding it runs for. That is
// all a task run needs, so the caller only relays a request a job printed,
// and a buddy could issue the same request later (`buddy-replaces-actor`,
// `bindings-and-ready-tasks`). A task job (`job.mjs --task`) runs one, and
// prints a report of its run beside the job's own end: the task, binding,
// run and verdict, so a held or unknown result never reads as a finished job.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { Stage } from "../stages.ts";
import type { Binding } from "../task-result-records.ts";
import { BINDING } from "../task-result-records.ts";

// The tasks a job may be asked to run, by their command-line names.
const JOB_TASKS = ["sync", "integration"] as const;

type JobTask = (typeof JOB_TASKS)[number];

// Each requestable task's name in a binding.
const TASK_NAMES = { sync: "Sync", integration: "Integration" } as const;

type RequestedTask = (typeof TASK_NAMES)[JobTask];

// The saved stages a task may run at: Sync before Hardening (review) or
// after it (merge); Integration only once Hardening sent the issue to merge.
const TASK_STAGES: Readonly<Record<JobTask, readonly Stage[]>> = {
  sync: ["review", "merge"],
  integration: ["merge"],
};

interface TaskRequest {
  task: RequestedTask;
  binding: Binding;
}

// How a task run came out. passed, failed and refused are the run's
// recorded verdict; unknown means no verdict was established (the run may
// have had effects), and held that the records or a limit need a person.
// Neither unknown nor held is ever a completed task.
const TASK_VERDICTS = [
  "passed",
  "failed",
  "refused",
  "unknown",
  "held",
] as const;

type TaskVerdict = (typeof TASK_VERDICTS)[number];

interface TaskReport {
  task: RequestedTask;
  binding: Binding;
  // The run the job recorded, or null when it recorded none.
  run: { id: string; previous: string | null } | null;
  verdict: TaskVerdict;
  // The revision a passed Sync produced.
  produced?: string;
}

// The request a task job was started with: the binding parsed strictly from
// its JSON, which must name the task asked for.
function taskRequestOf(task: JobTask, json: string): TaskRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new Error("--binding must be a task binding as JSON", {
      cause: error,
    });
  }
  const parsed = BINDING.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`--binding: ${z.prettifyError(parsed.error)}`);
  }
  const name = TASK_NAMES[task];
  if (parsed.data.task !== name) {
    throw new Error(
      `--binding is for ${parsed.data.task}, not the requested ${name}`,
    );
  }
  return { task: name, binding: parsed.data };
}

// Why `request` isn't issue `issue`'s in `cfg`, or null when it is: its
// repository, work item and target branch are this job's, and it binds a
// revision.
function requestRefusalOf(
  cfg: Pick<Config, "repo" | "baseBranch">,
  issue: number,
  request: TaskRequest,
): string | null {
  const { binding } = request;
  if (binding.repo !== cfg.repo || binding.workItem !== issue) {
    return `the ${request.task} binding is for ${binding.repo}#${binding.workItem}, not ${cfg.repo}#${issue}`;
  }
  if (binding.target.branch !== cfg.baseBranch) {
    return `the ${request.task} binding targets ${binding.target.branch}, not ${cfg.baseBranch}`;
  }
  if (!("revision" in binding)) {
    return `the ${request.task} binding names no revision`;
  }
  return null;
}

export type { JobTask, RequestedTask, TaskReport, TaskRequest, TaskVerdict };
export {
  JOB_TASKS,
  requestRefusalOf,
  TASK_NAMES,
  TASK_STAGES,
  TASK_VERDICTS,
  taskRequestOf,
};
