// The orchestrator's rules (#234): given a snapshot of the open issues and
// their jobs, which stage jobs start now and why each other runnable issue is
// held. Pure: the snapshot carries everything it reads, so recorded snapshots
// test it with no clock, files or processes.

import { fileSetsOverlap } from "../globs.ts";
import type { ScheduleSettings, Snapshot, SnapshotIssue } from "./queue.ts";
import {
  byAge,
  fileSet,
  isLive,
  isLiveImplementation,
  isStopped,
  mergeRank,
  runStage,
  stageIndex,
  verdictHold,
  WRITERS,
} from "./queue.ts";
import { stackPartners, stackRule } from "./stacking.ts";

type Decision =
  | {
      action: "started";
      at: string;
      issue: number;
      stage: string;
      reason: "free" | "merge-first";
      mergeQueue: readonly number[] | null;
      // The prerequisite a first job starts the issue's branch on (#290).
      stackOn: number | null;
    }
  | {
      action: "held";
      at: string;
      issue: number;
      stage: string;
      reason: string;
    };

type Role = "reader" | "writer" | "merge";

// What a tick has decided so far, which later decisions read.
interface TickCount {
  settings: ScheduleSettings;
  spent: number;
  live: number;
  liveAt: Map<string, number>;
  implementations: SnapshotIssue[];
  mergeLive: number | null;
  queue: readonly number[];
}

function roleOf(stage: string): Role {
  if (stage === "merge") {
    return "merge";
  }
  if (WRITERS.has(stage)) {
    return "writer";
  }
  return "reader";
}

function capReason(
  count: TickCount,
  stage: string,
): "global-cap" | "stage-cap" | null {
  const { maxJobs, stageCaps } = count.settings;
  if (count.live >= maxJobs) {
    return "global-cap";
  }
  const { [stage]: cap = Number.POSITIVE_INFINITY } = stageCaps;
  if ((count.liveAt.get(stage) ?? 0) >= cap) {
    return "stage-cap";
  }
  return null;
}

// The issue's place in the merge queue, or infinity when it isn't queued.
function queueRank(count: TickCount, issue: SnapshotIssue): number {
  const at = count.queue.indexOf(issue.number);
  if (at < 0) {
    return Number.POSITIVE_INFINITY;
  }
  return at;
}

// The oldest live implementation whose files overlap the issue's: any for an
// implement, but for a live issue's fix, sync or checks only an older one that
// doesn't merge after it. A queued issue's writer is never held by one queued
// later or not queued, so the merge queue's top always moves, and a writer
// hold and a merge-order hold can't form a cycle. An issue and its
// prerequisite never hold each other.
function overlapReason(
  count: TickCount,
  issue: SnapshotIssue,
  stage: string,
): string | null {
  const blocker = count.implementations
    .filter(
      (other) =>
        other.number !== issue.number &&
        !stackPartners(issue, other) &&
        (stage === "implement" ||
          (byAge(other, issue) < 0 &&
            queueRank(count, other) <= queueRank(count, issue))) &&
        fileSetsOverlap(fileSet(other), fileSet(issue)),
    )
    .sort(byAge)
    .at(0);
  if (blocker === undefined) {
    return null;
  }
  return `files-overlap:#${blocker.number}`;
}

function mergeReason(count: TickCount, issue: SnapshotIssue): string | null {
  const [top] = count.queue;
  if (top !== issue.number) {
    return `merge-order:#${String(top)}`;
  }
  if (count.mergeLive !== null) {
    return `merge-order:#${count.mergeLive}`;
  }
  return null;
}

function holdReason(
  count: TickCount,
  issue: SnapshotIssue,
  stage: string,
): string | null {
  const role = roleOf(stage);
  let reason: string | null;
  switch (role) {
    case "reader":
      reason = capReason(count, stage);
      break;
    case "writer":
      reason = overlapReason(count, issue, stage) ?? capReason(count, stage);
      break;
    case "merge":
      reason = mergeReason(count, issue) ?? capReason(count, stage);
      break;
    default: {
      const unknown: never = role;
      throw new Error(`unknown role ${String(unknown)}`);
    }
  }
  const limit = count.settings.tokensPerHour ?? 0; // null or 0: no limit
  if (reason === null && limit > 0 && count.spent >= limit) {
    return "rate-limit";
  }
  return reason;
}

// Counts a started job as live for the rest of the tick.
function countStart(
  count: TickCount,
  issue: SnapshotIssue,
  stage: string,
): void {
  count.live += 1;
  count.liveAt.set(stage, (count.liveAt.get(stage) ?? 0) + 1);
  if (stage === "implement") {
    count.implementations.push(issue);
  }
  if (stage === "merge") {
    count.mergeLive = issue.number;
  }
}

// The stage the issue's next job runs, what holds it before the caps and
// gates, and what its branch starts on; null for no decision. The stacking
// rules come first, then the classify verdict's hold.
function planOf(
  issue: SnapshotIssue,
): { stage: string; held: string | null; stackOn: number | null } | null {
  const rule = stackRule(issue);
  const stage = runStage(issue);
  switch (rule.kind) {
    case "run":
      return { stage: rule.stage, held: null, stackOn: rule.stackOn };
    case "hold":
      return { stage, held: rule.reason, stackOn: null };
    case "none": {
      const held = verdictHold(issue);
      if (held === undefined) {
        return null;
      }
      return { stage, held, stackOn: null };
    }
    default: {
      const unknown: never = rule;
      throw new Error(`unknown stack rule ${JSON.stringify(unknown)}`);
    }
  }
}

function decide(
  count: TickCount,
  issue: SnapshotIssue,
  at: string,
): Decision | null {
  const plan = planOf(issue);
  if (plan === null) {
    return null;
  }
  const { stage, stackOn } = plan;
  const reason = plan.held ?? holdReason(count, issue, stage);
  const { number } = issue;
  if (reason !== null) {
    return { action: "held", at, issue: number, stage, reason };
  }
  countStart(count, issue, stage);
  let why: "free" | "merge-first" = "free";
  let mergeQueue: readonly number[] | null = null;
  if (stage === "merge") {
    why = "merge-first";
    mergeQueue = count.queue;
  }
  return {
    action: "started",
    at,
    issue: number,
    stage,
    reason: why,
    mergeQueue,
    stackOn,
  };
}

function countOf(snapshot: Snapshot, settings: ScheduleSettings): TickCount {
  const liveAt = new Map<string, number>();
  let mergeLive: number | null = null;
  for (const { job, number } of snapshot.issues) {
    if (job?.live === true) {
      liveAt.set(job.stage, (liveAt.get(job.stage) ?? 0) + 1);
      if (job.stage === "merge") {
        mergeLive = number;
      }
    }
  }
  return {
    settings,
    spent: snapshot.spentLastHour,
    live: snapshot.issues.filter(isLive).length,
    liveAt,
    implementations: snapshot.issues.filter(isLiveImplementation),
    mergeLive,
    queue: mergeRank(snapshot.issues),
  };
}

// Finish work first: the later stage first, then the older issue.
function byStageThenAge(a: SnapshotIssue, b: SnapshotIssue): number {
  return stageIndex(runStage(b)) - stageIndex(runStage(a)) || byAge(a, b);
}

// One decision for each issue that may run a stage: those stopped, done or
// with a live job get none.
function schedule(
  snapshot: Snapshot,
  settings: ScheduleSettings,
  now: Date,
): Decision[] {
  const count = countOf(snapshot, settings);
  const at = now.toISOString();
  return snapshot.issues
    .filter(
      (issue) =>
        !(isStopped(issue) || isLive(issue)) &&
        stageIndex(runStage(issue)) >= 0,
    )
    .sort(byStageThenAge)
    .flatMap((issue) => decide(count, issue, at) ?? []);
}

// Why a restart of `stage` for issue `number` is held now, or null once it
// is admitted: a restart passes the same caps, file overlaps, merge order
// and rate limit as a start, and counts against them for the later ones.
type StartGate = (number: number, stage: string) => string | null;

function startGate(snapshot: Snapshot, settings: ScheduleSettings): StartGate {
  const count = countOf(snapshot, settings);
  return (number: number, stage: string): string | null => {
    const issue = snapshot.issues.find((open) => open.number === number);
    if (issue === undefined) {
      return "not-open";
    }
    const reason = holdReason(count, issue, stage);
    if (reason === null) {
      countStart(count, issue, stage);
    }
    return reason;
  };
}

export type { Decision, StartGate };
export { schedule, startGate };
