// A stage or task job started for an assignment (`--assignment`, which the
// sweep passes, #119): its buddy's account must still hold the grantor's
// assignment (src/assignment/grant.ts). The job checks before it acquires
// ownership, before each writer session and each push, and before it applies
// its role's end; every credentialed write rechecks through the config's
// grant (execution.ts). A paused job ends `wait`, `paused: …`, and writes
// nothing more: its last saved state is its checkpoint, and teardown keeps
// its local work as on any exit.
//
// The buddy is the one whose role holds the work (`two-buddies`): Hippy,
// the development account, for Author, Implementation, Hardening and Sync;
// Lawd, the landing account, for the merge stage and Integration.

import { assignmentGrant } from "../assignment/grant.ts";
import type { Config } from "../config.ts";
import type { Stage } from "../stages.ts";
import type { RunArgs } from "./args.ts";
import type { JobTask, TaskRequest } from "./task-request.ts";
import type { RunEnd } from "./teardown.ts";

// The job's assignment: its config, which carries the grant every write
// rechecks, and what reads, fresh, why the work item is paused, or null.
interface Assignment {
  cfg: Config;
  paused: () => string | null;
}

// The account whose assignment grants a `stage` job, or its `task`.
function buddyAccountOf(
  cfg: Config,
  stage: Stage,
  task: JobTask | null,
): string {
  if (task === "integration" || (task === null && stage === "merge")) {
    return cfg.landingAccount;
  }
  return cfg.devAccount;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Why `login`'s grant of `issue` doesn't hold, read fresh, or null.
function pauseOf(cfg: Config, issue: number, login: string): string | null {
  try {
    const grant = assignmentGrant(cfg, issue, login);
    if (grant.granted) {
      return null;
    }
    return `paused: ${grant.why}`;
  } catch (error: unknown) {
    return `paused: ${messageOf(error)}`;
  }
}

function assignmentOf(
  cfg: Config,
  job: { issue: number; stage: Stage; task: JobTask | null },
): Assignment {
  const login = buddyAccountOf(cfg, job.stage, job.task);
  const granted: Config = { ...cfg, grant: { login } };
  return {
    cfg: granted,
    paused: (): string | null => pauseOf(granted, job.issue, login),
  };
}

// `check` that also throws while the work item is paused.
function grantedCheck(
  check: () => void,
  assignment: Assignment | null,
): () => void {
  return (): void => {
    check();
    const paused = assignment?.paused() ?? null;
    if (paused !== null) {
      throw new Error(paused);
    }
  };
}

// The line of a job paused before it acquired: `wait`, and a task job's
// report of no run.
function pausedRun(
  job: { issue: number; stage: Stage },
  task: (TaskRequest & { name: JobTask }) | null,
  reason: string,
): RunEnd {
  const summary: Extract<RunEnd, { kind: "finished" }>["summary"] = {
    ...job,
    end: "wait",
    reason,
  };
  if (task !== null) {
    const { name: _name, ...request } = task;
    summary.task = { ...request, run: null, verdict: "unknown" };
  }
  return { kind: "finished", summary };
}

// A `--assignment` run's config and assignment, or the end of one paused
// before it acquired; any other run's config unchanged, with no assignment.
function assignedRun(
  cfg: Config,
  args: RunArgs,
): { cfg: Config; assignment: Assignment | null } | { end: RunEnd } {
  if (args.assignment !== true) {
    return { cfg, assignment: null };
  }
  const { issue, stage } = args;
  const task = args.task?.name ?? null;
  const assignment = assignmentOf(cfg, { issue, stage, task });
  const paused = assignment.paused();
  if (paused !== null) {
    return { end: pausedRun({ issue, stage }, args.task, paused) };
  }
  return { cfg: assignment.cfg, assignment };
}

export type { Assignment };
export { assignedRun, buddyAccountOf, grantedCheck };
