// The watchdog's budget rule (#281): a live job whose session launch's
// context (job.json's `contextTokens`, the latest message's token total)
// went past its token budget gets SIGTERM once, and once it has exited its
// issue is stopped with the budget stop and never restarted. The SIGTERM
// comes first because a job saves the issue's state on SIGTERM, which would
// overwrite the stop's. Ops launches, launches with no budget and launches
// that ended are never stopped. Pure: the tick carries out its actions. A
// session the job stopped at the hard context limit has ended though its
// outcome waits for its retry (#272), so no live-session check counts it.

import type { StatusFile } from "../job/status.ts";
import type { WatchAction, WatchedJob } from "./watchdog.ts";
import type { OverBudget, WatchMemory } from "./watchdog-memory.ts";

type Launch = StatusFile["launches"][number];

function jobId(status: StatusFile): string {
  return `${status.issue} ${status.startedAt}`;
}

// Whether `launch` is a session still running: no outcome yet and not
// stopped at the hard context limit.
function isLiveSession(launch: Launch): boolean {
  return (
    launch.kind === "session" &&
    launch.outcome === null &&
    launch.contextStop === null
  );
}

function isOver(launch: Launch): launch is Launch & { tokenBudget: number } {
  return (
    isLiveSession(launch) &&
    launch.tokenBudget !== null &&
    launch.contextTokens > launch.tokenBudget
  );
}

// The comment's reason for the budget stop of `over`.
function budgetReason(over: OverBudget): string {
  return `a session went past its token budget: ${over.key}'s context reached ${over.contextTokens} tokens, over its budget of ${over.tokenBudget}`;
}

// The action the rule takes on `job` this tick, an empty list when it has
// none, or null when the job is not the rule's: never past a budget, not
// running, or already sent SIGTERM for silence. A job the rule holds is the rule's alone, so the
// watchdog neither revives nor steers it.
function budgetActions(
  job: WatchedJob,
  memory: WatchMemory,
  at: string,
): WatchAction[] | null {
  const { status } = job;
  const id = jobId(status);
  const base = { at, issue: status.issue, stage: status.stage };
  const over = memory.overBudget[id];
  if (over !== undefined) {
    if (job.live || over.stopped) {
      return [];
    }
    memory.overBudget[id] = { ...over, stopped: true };
    const reason = "budget";
    return [{ ...base, action: "stopped", reason, detail: budgetReason(over) }];
  }
  const launch = status.launches.find(isOver);
  if (
    launch === undefined ||
    !job.running ||
    status.outcome !== null ||
    memory.killed.includes(id)
  ) {
    return null;
  }
  const { key, contextTokens, tokenBudget } = launch;
  memory.overBudget[id] = { key, contextTokens, tokenBudget, stopped: false };
  const reason: `budget:${string}` = `budget:${key}`;
  return [{ ...base, action: "killed", reason, pid: status.pid }];
}

// Whether the watchdog stopped the job `status` names for its budget.
function budgetStopped(memory: WatchMemory, status: StatusFile): boolean {
  return memory.overBudget[jobId(status)]?.stopped === true;
}

export { budgetActions, budgetStopped, isLiveSession };
