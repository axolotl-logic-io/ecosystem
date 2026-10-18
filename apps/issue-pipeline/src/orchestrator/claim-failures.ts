// The orchestrator's failing-claim rule (#430): when claimFailureStreak of an
// issue's stage jobs in a row end with the same claim error (job.json's
// `claimError`), the issue is stopped with that error, at the stage the jobs
// ran. A job that ends with a different error starts the count again at 1,
// and one that ends any other way clears it. While the issue has a stop
// label, and right after this rule's stop, the count is 0, and the job that
// was there is not counted again, so a lifted issue is tried anew. Only jobs
// of this pipeline count: a legacy job.json is never an IssueJob. Pure: the
// tick carries out its stops and keeps the memory (watchdog-memory.ts).

import type { Stage } from "../stages.ts";
import { isStopLabel } from "../stops.ts";
import type { IssueJob, SnapshotIssue } from "./queue.ts";
import type { ClaimFailure } from "./watchdog-memory.ts";

// A stop this rule takes: the issue, the stage its jobs ran, and the stop
// comment's reason.
interface ClaimStop {
  issue: number;
  stage: Stage;
  detail: string;
}

// The claim error the ended `job` records, or null for any other end.
function claimErrorOf(job: IssueJob): string | null {
  const { end } = job;
  if (end?.kind !== "finished" || end.claimError === "") {
    return null;
  }
  return end.claimError;
}

// The streak ended job `job` leaves after `before`, or null when it ends one.
// A job counted already leaves it as it is.
function nextStreak(
  job: IssueJob,
  before: ClaimFailure | undefined,
  stopLabelled: boolean,
): ClaimFailure | null {
  const { startedAt } = job;
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

// The stops the failing-claim rule takes on the jobs of `issues`, and its
// memory after: only the streaks of issues with a job.
function claimFailureStops(
  issues: readonly SnapshotIssue[],
  streaks: Readonly<Record<string, ClaimFailure>>,
  claimFailureStreak: number,
): { stops: ClaimStop[]; streaks: Record<string, ClaimFailure> } {
  const kept: Record<string, ClaimFailure> = {};
  const stops: ClaimStop[] = [];
  const watched = issues.flatMap(({ number, job, labels }) => {
    if (job === null) {
      return [];
    }
    return [{ number, job, labels }];
  });
  for (const { number, job, labels } of watched) {
    const key = String(number);
    const before = streaks[key];
    let streak = before ?? null;
    if (!job.live && job.end !== null) {
      streak = nextStreak(job, before, labels.some(isStopLabel));
    }
    // Only a job counted this tick stops the issue.
    if (
      streak !== null &&
      streak !== before &&
      streak.count >= claimFailureStreak
    ) {
      const { count, error } = streak;
      const detail = `claim failed ${count} times in a row: ${error}`;
      stops.push({ issue: number, stage: job.stage, detail });
      streak = { ...streak, count: 0 };
    }
    if (streak !== null) {
      kept[key] = streak;
    }
  }
  return { stops, streaks: kept };
}

export type { ClaimStop };
export { claimFailureStops };
