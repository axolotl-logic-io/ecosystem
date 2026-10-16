// The orchestrator's view of the queue (#234): every open issue as the sweep
// op judges it (the same openIssues and classify, with stop labels,
// skipLabels, allowedUsers and after marks), its saved state, and its stage
// job, read from job.json or from the orchestrator's own start records. A job
// is live while its process is.

import process from "node:process";
import { z } from "zod";
import { leaseLane } from "../claims.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import type { StatusFile } from "../job/status.ts";
import { readStatus } from "../job/status.ts";
import { openIssues } from "../ops/sweep.ts";
import type { IssueRow, SweepContext } from "../ops/sweep-verdict.ts";
import { afterDeps, classify, liveLease } from "../ops/sweep-verdict.ts";
import type { State } from "../state.ts";
import { readState } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import type { StartRecord } from "./ledger.ts";
import type { IssueJob, IssueVerdict, SnapshotIssue } from "./queue.ts";

// The lane every orchestrator job runs in, so the next job for the same
// issue passes the sweep's lease check.
const LANE = "orchestrator";
const MS_PER_HOUR = 3_600_000;
const QUEUE_SETTINGS = z.looseObject({
  skipLabels: z.array(z.string()).nullish(),
  takeNewWork: z.unknown().optional(),
});

// The open issues, and the job.json of each that has one.
interface Queue {
  issues: SnapshotIssue[];
  jobs: StatusFile[];
}

// True while process `pid` runs: signal 0 checks without sending.
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function verdictOf(
  ctx: SweepContext,
  row: IssueRow,
  state: State | null,
): IssueVerdict {
  const verdict = classify(ctx, row);
  switch (verdict.kind) {
    case "candidate":
      return {
        kind: "candidate",
        answered: verdict.candidate.kind === "answered",
      };
    case "waiting-on-after":
      return { kind: "waiting-on-after" };
    case "live-elsewhere": {
      const lease = liveLease(state, ctx.now, ctx.leaseMs);
      return { kind: "live-elsewhere", lane: String(leaseLane(lease)) };
    }
    case "skip":
    case "skipped":
    case "parent":
      return { kind: "skip" };
    default: {
      const unknown: never = verdict;
      throw new Error(`unknown verdict ${JSON.stringify(unknown)}`);
    }
  }
}

// The issue's job: its job.json while that job runs, or else the last job
// the orchestrator started for it while that process runs.
function jobOf(
  status: StatusFile | null,
  start: StartRecord | undefined,
): IssueJob | null {
  if (status !== null && status.outcome === null && isAlive(status.pid)) {
    return { live: true, stage: status.stage };
  }
  if (start !== undefined && isAlive(start.pid)) {
    return { live: true, stage: start.stage };
  }
  if (status === null) {
    return null;
  }
  return { live: false, stage: status.stage };
}

function numberOr(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  return null;
}

function issueOf(
  ctx: SweepContext,
  row: IssueRow,
  started: readonly StartRecord[],
): { issue: SnapshotIssue; status: StatusFile | null } {
  const { state } = readState(ctx.cfg, row.number);
  const status = readStatus(paths.runDir(ctx.cfg, row.number));
  const start = started.findLast((s) => s.issue === row.number);
  const issue: SnapshotIssue = {
    number: row.number,
    createdAt: row.createdAt,
    verdict: verdictOf(ctx, row, state),
    stage: state?.stage ?? null,
    files: state?.files ?? null,
    pr: numberOr(state?.pr),
    after: afterDeps(row.body).filter((n) => ctx.openNumbers.has(n)),
    stopped: row.labels.some((label) => isStopLabel(label.name)),
    job: jobOf(status, start),
  };
  return { issue, status };
}

// The open issues and their jobs, as of `now`.
function readQueue(
  cfg: Config,
  started: readonly StartRecord[],
  now: Date,
): Queue {
  const settings = QUEUE_SETTINGS.parse(cfg);
  const rows = openIssues(cfg);
  const ctx: SweepContext = {
    cfg,
    lane: LANE,
    skipLabels: settings.skipLabels ?? [],
    takeNewWork: settings.takeNewWork !== false,
    openNumbers: new Set(rows.map((row) => row.number)),
    now: now.getTime(),
    leaseMs: cfg.leaseHours * MS_PER_HOUR,
  };
  const queue: Queue = { issues: [], jobs: [] };
  for (const row of rows) {
    const { issue, status } = issueOf(ctx, row, started);
    queue.issues.push(issue);
    if (status !== null) {
      queue.jobs.push(status);
    }
  }
  return queue;
}

export { LANE, readQueue };
