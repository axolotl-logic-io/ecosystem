// A stage job's invocation binding (#167): the job mints a fresh UUID for
// each run, never its --job-id or lane, and binds it to the issue, its
// assigned branch, the repo and its base. Before the job opens a checkout,
// writes job.json or runs an op, it requests and confirms issue-execution
// ownership itself, through the coordination transport (src/execution.ts)
// with the merge account. Ownership is read from authenticated coordination
// records, so a scripted or stale ops reply can never stand in for it.
//
// A loser cancels its pending request, so it never blocks the queue, and
// ends `unclaimed` having set up nothing. The owner relinquishes only after
// a resolved exit (resolvedRun); any other exit holds ownership for
// explicit reconciliation until #151's release predicate.

import type { Config } from "../config.ts";
import { paths, withCheckout } from "../config.ts";
import type { InvocationBinding } from "../coordination.ts";
import {
  executionBinding,
  issueExecution,
  withExecution,
} from "../execution.ts";
import type { Stage } from "../stages.ts";
import type { RunArgs } from "./args.ts";
import type { JobTask, TaskRequest } from "./task-request.ts";
import type { RunEnd } from "./teardown.ts";

// The job's confirmed ownership: its binding, and a config bound to it.
interface Invocation {
  binding: InvocationBinding;
  cfg: Config;
}

type Acquired = { owned: Invocation } | { lost: string; held: boolean };

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// `cfg` bound to a fresh binding for issue `issue` on the job's `lane` and
// assigned `branch`, its checkout at `dir`.
function bindInvocation(
  cfg: Config,
  issue: number,
  job: { lane: string; branch: string; dir: string },
): Invocation {
  const scoped = withCheckout(cfg, { issue, dir: job.dir, branch: job.branch });
  const binding = executionBinding(scoped, issue, job.lane);
  return { binding, cfg: withExecution(scoped, binding) };
}

// Requests and confirms ownership for `invocation`. A loser cancels its
// request; a hold (an unreadable, conflicting or uncertain record) keeps
// everything as it is and says why.
function acquireInvocation(invocation: Invocation): Acquired {
  const { cfg, binding } = invocation;
  try {
    const guard = issueExecution(cfg, binding.issue);
    guard.request();
    if (guard.acquire()) {
      return { owned: invocation };
    }
    guard.cancel();
    return { lost: "another invocation owns the issue", held: false };
  } catch (error: unknown) {
    return { lost: messageOf(error), held: true };
  }
}

// Throws unless `invocation` is still the confirmed owner, on a fresh read.
function assertInvocation(invocation: Invocation): void {
  issueExecution(invocation.cfg, invocation.binding.issue).assertOwner();
}

// What throws unless `invocation` still owns the issue on a fresh read:
// checked before each session and each push (#168).
function ownerCheckOf(invocation: Invocation): () => void {
  return (): void => assertInvocation(invocation);
}

// Whether the run that ended with `end` resolved: it finished with a line
// and no claim error, or a signal stopped it after it saved its last state
// with no lease (role-run.ts's stoppedAt throws when that save fails). A
// run that threw (null) or whose claim refused holds its ownership.
function resolvedRun(end: RunEnd | null): boolean {
  if (end === null) {
    return false;
  }
  return end.kind === "stopped" || end.summary.claimError === undefined;
}

// Releases `invocation`'s ownership after a resolved, torn-down run, so the
// next stage job can acquire.
function relinquishInvocation(invocation: Invocation): void {
  issueExecution(invocation.cfg, invocation.binding.issue).release();
}

// The line of a job that didn't acquire: `unclaimed`, with the hold as its
// claim error, and a task job's report of no run.
function lostRun(
  job: { issue: number; stage: Stage },
  task: (TaskRequest & { name: JobTask }) | null,
  lost: { lost: string; held: boolean },
): RunEnd {
  const summary: Extract<RunEnd, { kind: "finished" }>["summary"] = {
    ...job,
    end: "unclaimed",
    reason: lost.lost,
  };
  if (lost.held) {
    summary.claimError = lost.lost;
  }
  if (task !== null) {
    const { name: _name, ...request } = task;
    summary.task = { ...request, run: null, verdict: "unknown" };
  }
  return { kind: "finished", summary };
}

// The job's confirmed invocation for its `work` (its task or stage) on the
// claimant's lane, or the `unclaimed` end of a job that didn't acquire.
function ownedInvocation(
  cfg: Config,
  args: RunArgs,
  claimant: { lane: string; work: string },
): Invocation | { end: RunEnd } {
  const { issue, stage, branch } = args;
  const dir = paths.jobRepo(cfg, issue, claimant.work);
  const invocation = bindInvocation(cfg, issue, { ...claimant, branch, dir });
  const acquired = acquireInvocation(invocation);
  if ("lost" in acquired) {
    return { end: lostRun({ issue, stage }, args.task, acquired) };
  }
  return invocation;
}

// After teardown: releases ownership when the run that ended with `end`
// resolved, and holds it otherwise.
function settleInvocation(invocation: Invocation, end: RunEnd | null): void {
  if (resolvedRun(end)) {
    relinquishInvocation(invocation);
  }
}

export type { Invocation };
export { ownedInvocation, ownerCheckOf, settleInvocation };
