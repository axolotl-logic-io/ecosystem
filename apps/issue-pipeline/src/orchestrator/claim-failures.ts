// The orchestrator's failing-claim rule (#430): when claimFailureStreak of an
// issue's stage jobs in a row end with the same claim error (job.json's
// `claimError`), the issue is stopped with that error, at the stage the jobs
// ran. A job that ends with a different error starts the count again at 1,
// and one that ends any other way clears it. While the issue has a stop
// label, and right after this rule's stop, the count is 0, and the job.json
// that was there is not counted again, so a lifted issue is tried anew. The
// rule counts a lifted issue saved at `stopped` too, unlike the watchdog's
// other rules: its failing claims never get to save another state. Pure: the
// tick carries out its actions and keeps the memory (watchdog-memory.ts).

import type { WatchAction, WatchedJob } from "./watchdog.ts";
import type { ClaimFailure, WatchMemory } from "./watchdog-memory.ts";

interface ClaimFailureRun {
  claimFailureStreak: number;
  now: Date;
}

// The claim error job.json records for `job`, or null for any other end.
function claimErrorOf(job: WatchedJob): string | null {
  const { outcome } = job.status;
  if (outcome?.kind !== "finished" || outcome.claimError === undefined) {
    return null;
  }
  return outcome.claimError || null;
}

// The streak ended job `job` leaves after `before`, or null when it ends one.
// A job counted already leaves it as it is.
function nextStreak(
  job: WatchedJob,
  before: ClaimFailure | undefined,
  stopLabelled: boolean,
): ClaimFailure | null {
  const { startedAt } = job.status;
  if (stopLabelled) {
    return { error: before?.error ?? "", count: 0, job: startedAt };
  }
  if (before?.job === startedAt) {
    return before;
  }
  const error = claimErrorOf(job);
  if (error === null) {
    return null;
  }
  let count = 1;
  if (before?.error === error) {
    count = before.count + 1;
  }
  return { error, count, job: startedAt };
}

// The stops the failing-claim rule takes on `jobs` as of `run.now`, given
// the issues that carry a stop label, and its memory after. The memory keeps
// only the streaks of issues with a watched job.
function claimFailureActions(
  jobs: readonly WatchedJob[],
  stopLabelled: ReadonlySet<number>,
  memory: WatchMemory,
  run: ClaimFailureRun,
): { actions: WatchAction[]; memory: WatchMemory } {
  const streaks: Record<string, ClaimFailure> = {};
  const actions: WatchAction[] = [];
  const at = run.now.toISOString();
  for (const job of jobs) {
    const { issue, stage } = job.status;
    const key = String(issue);
    const before = memory.claimFailures[key];
    let streak = before ?? null;
    if (!job.live && job.status.outcome !== null) {
      streak = nextStreak(job, before, stopLabelled.has(issue));
    }
    // Only a job counted this tick stops the issue.
    if (
      streak !== null &&
      streak !== before &&
      streak.count >= run.claimFailureStreak
    ) {
      const { count, error } = streak;
      const detail = `claim failed ${count} times in a row: ${error}`;
      const reason = "claim-failed";
      actions.push({ at, issue, stage, action: "stopped", reason, detail });
      streak = { ...streak, count: 0 };
    }
    if (streak !== null) {
      streaks[key] = streak;
    }
  }
  return { actions, memory: { ...memory, claimFailures: streaks } };
}

export { claimFailureActions };
