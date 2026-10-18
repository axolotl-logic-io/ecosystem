// The orchestrator's view of the queue: every open issue as GitHub has it
// (labels, author, after mark, saved state, trusted-inputs revisions) and its
// stage job, read from its job.json or from the orchestrator's record of the
// start. Only a job.json that names `pipelineVersion: 2` is a job of this
// pipeline. A legacy one, whose stage names (implement, review, merge)
// overlap this pipeline's, is never restarted or counted: while its process
// runs it holds its issue, and once that process is gone it is ignored, so
// the issue starts afresh from its migrated state. A job is live while its
// process is, as `alive` judges a pid, checking the process is a stage job
// where it can, so a reused pid doesn't count.

import { listComments } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { isAllowedUser } from "../github.ts";
import type { StatusFile } from "../job/status.ts";
import { currentStageOf, isPipelineJob, readStatus } from "../job/status.ts";
import { LABELS } from "../labels.ts";
import { readState } from "../saved-state.ts";
import { isStage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { afterMarkOf, inputRevisionsOf } from "./inputs.ts";
import type { IssueRow } from "./open-issues.ts";
import { openIssues } from "./open-issues.ts";
import type {
  InputRevisions,
  IssueJob,
  JobEnd,
  Snapshot,
  SnapshotIssue,
} from "./queue.ts";
import type { StartRecord } from "./start-job.ts";

// The queue as of one read: the snapshot the scheduler reads, each issue's
// saved state, the ends of this pipeline's jobs, and the open split parents.
interface Queue {
  snapshot: Snapshot;
  states: Map<number, IssueState | null>;
  ends: JobEnd[];
  parents: number[];
}

interface QueueRead {
  alive: (pid: number) => boolean;
  starts: readonly StartRecord[];
  mergeWindow: number | null;
}

function endOf(status: StatusFile): JobEnd | null {
  const { outcome } = status;
  const at = status.endedAt ?? status.startedAt;
  switch (outcome?.kind) {
    case undefined:
      return null;
    case "finished":
      return {
        kind: "finished",
        at,
        rateLimited: outcome.rateLimited === true,
        claimError: outcome.claimError ?? null,
      };
    case "stopped":
    case "failed":
      return { kind: outcome.kind, at };
    default: {
      const unknown: never = outcome;
      throw new Error(`unknown job outcome ${JSON.stringify(unknown)}`);
    }
  }
}

// The job the orchestrator started last, while its process runs.
function startedJob(
  start: StartRecord | undefined,
  alive: QueueRead["alive"],
): IssueJob | null {
  if (start === undefined || !alive(start.pid)) {
    return null;
  }
  return { stage: start.stage, startedAt: start.at, live: true, end: null };
}

// The issue's job, and whether a legacy job of it still runs.
function jobOf(
  status: StatusFile | null,
  start: StartRecord | undefined,
  alive: QueueRead["alive"],
): { job: IssueJob | null; legacyLive: boolean } {
  const started = startedJob(start, alive);
  if (status === null) {
    return { job: started, legacyLive: false };
  }
  const running = status.outcome === null && alive(status.pid);
  const stage = currentStageOf(status);
  if (!(isPipelineJob(status) && isStage(stage))) {
    return { job: started, legacyLive: running };
  }
  if (!running && started !== null) {
    return { job: started, legacyLive: false };
  }
  const { startedAt } = status;
  const end = endOf(status);
  return { job: { stage, startedAt, live: running, end }, legacyLive: false };
}

function issueOf(
  cfg: Config,
  row: IssueRow,
  read: QueueRead & { open: ReadonlySet<number> },
): { issue: SnapshotIssue; state: IssueState | null } {
  const { number } = row;
  const comments = listComments(cfg, number);
  const { state } = readState(cfg, number, comments);
  const status = readStatus(paths.runDir(cfg, number));
  const start = read.starts.findLast((s) => s.issue === number);
  const login = row.author?.login;
  const authorAllowed = isAllowedUser(cfg, login);
  let inputs: InputRevisions | null = null;
  if (authorAllowed && typeof login === "string") {
    inputs = inputRevisionsOf(
      cfg,
      number,
      { title: row.title, body: row.body, user: { login } },
      { comments, state },
    );
  }
  const issue: SnapshotIssue = {
    number,
    createdAt: row.createdAt,
    labels: row.labels.map((label) => label.name),
    authorAllowed,
    state,
    after: afterMarkOf(row.body).filter((n) => read.open.has(n)),
    inputs,
    ...jobOf(status, start, read.alive),
  };
  return { issue, state };
}

// An open split parent the tick closes once its sub-issues are done.
function isParent(issue: SnapshotIssue): boolean {
  return (
    issue.authorAllowed &&
    issue.labels.includes(LABELS.split.name) &&
    !issue.labels.some(isStopLabel)
  );
}

// The open issues and their jobs.
function readQueue(cfg: Config, read: QueueRead): Queue {
  const rows = openIssues(cfg);
  const open = new Set(rows.map((row) => row.number));
  const issues: SnapshotIssue[] = [];
  const states = new Map<number, IssueState | null>();
  for (const row of rows) {
    const { issue, state } = issueOf(cfg, row, { ...read, open });
    issues.push(issue);
    states.set(row.number, state);
  }
  const ends = issues.flatMap(({ job }) => job?.end ?? []);
  return {
    snapshot: { issues, mergeWindow: read.mergeWindow },
    states,
    ends,
    parents: issues.filter(isParent).map(({ number }) => number),
  };
}

export type { Queue, QueueRead };
export { readQueue };
