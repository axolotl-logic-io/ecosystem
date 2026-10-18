// The orchestrator's watchdog: the bounded restart of a dead stage job. A job
// of this pipeline that ended with no outcome while its process is gone, or
// that failed with an error, is dead. When the issue's next job runs the
// stage the dead job was at, that start is a restart: at most maxResumes per
// issue and stage, after which the issue stops with agent:stopped-job, and a
// stop clears the issue's count, so a lifted issue starts again from none. A
// start at another stage is a fresh start and counts nothing. A legacy
// job.json is never an IssueJob, so it is never restarted. Pure: the
// scheduler admits the restart and the tick keeps the counts
// (watchdog-memory.ts).

import type { Stage } from "../stages.ts";
import type { IssueJob } from "./queue.ts";

// What the issue's next start at a stage is: a fresh start, a restart with
// its attempt number, or none, since the issue stops.
type Restart =
  | { kind: "fresh" }
  | { kind: "restart"; attempt: number }
  | { kind: "stop" };

// Restarts so far, by `<issue> <stage>`.
type Resumes = Record<string, number>;

function isDead(job: IssueJob | null): job is IssueJob {
  return (
    job !== null && !job.live && (job.end === null || job.end.kind === "failed")
  );
}

function resumeKey(issue: number, stage: Stage): string {
  return `${issue} ${stage}`;
}

// What issue `issue`'s next start at `stage` is, given its latest job.
function restartOf(
  issue: number,
  job: IssueJob | null,
  stage: Stage,
  settings: { resumes: Readonly<Resumes>; maxResumes: number },
): Restart {
  if (!isDead(job) || job.stage !== stage) {
    return { kind: "fresh" };
  }
  const count = settings.resumes[resumeKey(issue, stage)] ?? 0;
  if (count >= settings.maxResumes) {
    return { kind: "stop" };
  }
  return { kind: "restart", attempt: count + 1 };
}

// `resumes` with the restart `attempt` of issue `issue`'s `stage` counted.
function withRestart(
  resumes: Readonly<Resumes>,
  issue: number,
  stage: Stage,
  attempt: number,
): Resumes {
  return { ...resumes, [resumeKey(issue, stage)]: attempt };
}

// `resumes` with issue `issue`'s counts cleared, as its stop resets them.
function withoutIssue(resumes: Readonly<Resumes>, issue: number): Resumes {
  return Object.fromEntries(
    Object.entries(resumes).filter(([key]) => !key.startsWith(`${issue} `)),
  );
}

export type { Restart, Resumes };
export { isDead, restartOf, withoutIssue, withRestart };
