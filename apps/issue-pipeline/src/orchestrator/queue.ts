// The queue the orchestrator schedules: the snapshot of the open issues and
// their stage jobs, and the settings the scheduler reads. Pure types, so
// recorded snapshots test the scheduler with no clock, files or processes.

import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";

// How a pipeline-version-2 stage job ended, as its job.json records it:
// finished (with whether its issue deferred on a provider's rate limit or a
// transport error, and the error of a claim that failed), stopped by a
// signal, or failed with an error.
type JobEnd =
  | {
      kind: "finished";
      at: string;
      rateLimited: boolean;
      claimError: string | null;
    }
  | { kind: "stopped"; at: string }
  | { kind: "failed"; at: string };

// The issue's latest stage job of this pipeline: from its job.json when that
// names `pipelineVersion: 2`, or from the orchestrator's own record of the
// start until the job writes one. `startedAt` names the job; `stage` is the
// stage it is at now; `end` is null while it runs or when it died with no
// outcome. A legacy job.json is never an IssueJob.
interface IssueJob {
  stage: Stage;
  startedAt: string;
  live: boolean;
  end: JobEnd | null;
}

// The trusted-inputs revisions the scheduler compares: the current one
// (trustedInputsHash over the issue and its trusted comments), the one the
// issue's Gherkin comment was written from, and the one its author's
// questions were asked on (the state's `asked`), each null when absent.
interface InputRevisions {
  current: string;
  gherkin: string | null;
  asked: string | null;
}

interface SnapshotIssue {
  number: number;
  createdAt: string;
  labels: readonly string[];
  // The issue's author is on allowedUsers and still a collaborator.
  authorAllowed: boolean;
  // Its saved state, or null with none.
  state: IssueState | null;
  // The open issues its after mark names.
  after: readonly number[];
  // Absent when the issue author is not currently trusted.
  inputs: InputRevisions | null;
  job: IssueJob | null;
  // A legacy job.json (no `pipelineVersion: 2`) whose process still runs.
  legacyLive: boolean;
}

interface Snapshot {
  issues: readonly SnapshotIssue[];
  // The issue holding the merge window, as the orchestrator last reserved
  // it, or null.
  mergeWindow: number | null;
}

interface ScheduleSettings {
  maxJobs: number;
  stageCaps: Readonly<Partial<Record<Stage, number>>>;
  // Restarts of one issue's stage after its job died, before the issue stops.
  maxResumes: number;
  skipLabels: readonly string[];
  // false: issues with no saved state are not started (config takeNewWork).
  takeNewWork: boolean;
  // How long a lease stays live (config leaseHours).
  leaseMs: number;
}

export type {
  InputRevisions,
  IssueJob,
  JobEnd,
  ScheduleSettings,
  Snapshot,
  SnapshotIssue,
};
