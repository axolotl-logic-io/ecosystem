// The orchestrator's scheduler: given a snapshot of the open issues and their
// jobs, which stage jobs start now, which issues stop, and why each other
// issue that needs a job is held. Pure.
//
// Each issue's plan (issue-plan.ts) comes first. A start then passes:
// - the backoff gate, which holds every start while a rate-limit or
//   transport backoff runs (rate-limit-backoff.ts);
// - the merge window: one issue at a time rebases, verifies, is reviewed
//   again when its head changed, and lands. The issue that holds it keeps
//   it while it is at review or merge, so other Lands never push it behind
//   its base in a loop; its jobs go first, and every other Land is held.
//   With no holder the merge-ready issue ranked first opens the window: the
//   one the most open issues wait on, then the lower PR, then the lower
//   number. A merge job gets that ranking as its landing order. A completion's
//   merge job never lands, so it has no part in the window or the queue;
// - the caps: maxJobs live jobs in all, and stageCaps per stage, counting
//   every live job, a legacy job's included;
// - the watchdog (watchdog.ts): a start at the stage a dead job died at is a
//   restart, counted, and past maxResumes the issue stops instead.
// Later stages go first, then older issues.

import type { Stage } from "../stages.ts";
import type { IssuePlan, Reauthor, StartReason } from "./issue-plan.ts";
import { isCompletion, planOf } from "./issue-plan.ts";
import type { ScheduleSettings, Snapshot, SnapshotIssue } from "./queue.ts";
import type { Resumes } from "./watchdog.ts";
import { restartOf, withoutIssue, withRestart } from "./watchdog.ts";

const STAGE_RANK: Readonly<Record<Stage, number>> = {
  merge: 0,
  review: 1,
  implement: 2,
  author: 3,
};
const WINDOW_STAGES: ReadonlySet<Stage> = new Set(["review", "merge"]);

type Decision =
  | {
      action: "started";
      at: string;
      issue: number;
      stage: Stage;
      reason: StartReason | "restart";
      // The state to save before the start, for new trusted input.
      reauthor: Reauthor | null;
      // A code Land's landing order, holder first; null for other stages and
      // for a completion's merge job.
      mergeQueue: readonly number[] | null;
    }
  | { action: "held"; at: string; issue: number; stage: Stage; reason: string }
  | {
      action: "stopped";
      at: string;
      issue: number;
      stage: Stage;
      reason: "max-resumes";
    };

// What the scheduler remembers between ticks.
interface ScheduleMemory {
  resumes: Resumes;
  mergeWindow: number | null;
}

interface Planned {
  issue: SnapshotIssue;
  plan: Exclude<IssuePlan, { kind: "none" }>;
}

// What a tick has decided so far, which later decisions read.
interface Count {
  settings: ScheduleSettings;
  live: number;
  liveAt: Map<Stage, number>;
  holder: number | null;
  queue: readonly number[];
  memory: ScheduleMemory;
}

function isWindowRun(planned: Planned | undefined): boolean {
  return planned?.plan.kind === "run" && WINDOW_STAGES.has(planned.plan.stage);
}

// True for a job at `stage` that lands code: a Land, not a completion's.
function isCodeLand(stage: Stage, issue: SnapshotIssue): boolean {
  return stage === "merge" && !isCompletion(issue.state);
}

// The issue holding the merge window: one with a live code Land, else the
// last reserved holder while its live job or its next job is at review or
// merge. A holder held for any other reason, sent back to the author or the
// Developer, stopped, closed or now a completion gives the window up.
function holderOf(
  snapshot: Snapshot,
  planned: readonly Planned[],
): number | null {
  const liveLand = snapshot.issues.find(
    (open) => open.job?.live === true && isCodeLand(open.job.stage, open),
  );
  if (liveLand !== undefined) {
    return liveLand.number;
  }
  const reserved = snapshot.issues.find(
    ({ number }) => number === snapshot.mergeWindow,
  );
  if (reserved === undefined || isCompletion(reserved.state)) {
    return null;
  }
  const { job } = reserved;
  const liveInWindow = job?.live === true && WINDOW_STAGES.has(job.stage);
  const next = planned.find(({ issue }) => issue.number === reserved.number);
  if (liveInWindow || isWindowRun(next)) {
    return reserved.number;
  }
  return null;
}

// The open issues whose after mark names `number`.
function dependents(snapshot: Snapshot, number: number): number {
  return snapshot.issues.filter(({ after }) => after.includes(number)).length;
}

// The merge-ready issues in landing order, the window's holder first.
function landingOrderOf(
  snapshot: Snapshot,
  planned: readonly Planned[],
  holder: number | null,
): number[] {
  const ready = planned
    .filter(
      ({ issue, plan }) => plan.kind === "run" && isCodeLand(plan.stage, issue),
    )
    .map(({ issue }) => ({
      number: issue.number,
      waiting: dependents(snapshot, issue.number),
      pr: issue.state?.pr ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => b.waiting - a.waiting || a.pr - b.pr || a.number - b.number)
    .map(({ number }) => number);
  if (holder === null) {
    return ready;
  }
  return [holder, ...ready.filter((number) => number !== holder)];
}

function capReason(
  count: Count,
  stage: Stage,
): "global-cap" | "stage-cap" | null {
  if (count.live >= count.settings.maxJobs) {
    return "global-cap";
  }
  const { [stage]: cap = Number.POSITIVE_INFINITY } = count.settings.stageCaps;
  if ((count.liveAt.get(stage) ?? 0) >= cap) {
    return "stage-cap";
  }
  return null;
}

// Why a Land of `issue` waits for the window, or null when it may run.
function windowReason(count: Count, issue: number): string | null {
  if (count.holder !== null && count.holder !== issue) {
    return `merge-window:#${count.holder}`;
  }
  const [first] = count.queue;
  if (first !== undefined && first !== issue) {
    return `merge-order:#${first}`;
  }
  return null;
}

function countStart(count: Count, stage: Stage): void {
  count.live += 1;
  count.liveAt.set(stage, (count.liveAt.get(stage) ?? 0) + 1);
}

function decide(
  count: Count,
  { issue, plan }: Planned,
  run: { at: string; gate: string | null },
): Decision {
  const { at } = run;
  const { number } = issue;
  const { stage } = plan;
  if (plan.kind === "held") {
    return { action: "held", at, issue: number, stage, reason: plan.reason };
  }
  const { maxResumes } = count.settings;
  const { resumes } = count.memory;
  const restart = restartOf(number, issue.job, stage, { resumes, maxResumes });
  if (restart.kind === "stop") {
    count.memory.resumes = withoutIssue(resumes, number);
    return {
      action: "stopped",
      at,
      issue: number,
      stage,
      reason: "max-resumes",
    };
  }
  const codeLand = isCodeLand(stage, issue);
  let reason: string | null = null;
  if (codeLand) {
    reason = windowReason(count, number);
  }
  reason = run.gate ?? reason ?? capReason(count, stage);
  if (reason !== null) {
    return { action: "held", at, issue: number, stage, reason };
  }
  let started: StartReason | "restart" = plan.reason;
  if (restart.kind === "restart") {
    count.memory.resumes = withRestart(resumes, number, stage, restart.attempt);
    started = "restart";
  }
  countStart(count, stage);
  let mergeQueue: readonly number[] | null = null;
  if (codeLand) {
    count.holder = number;
    count.memory.mergeWindow = number;
    mergeQueue = count.queue;
  }
  const { reauthor } = plan;
  return {
    action: "started",
    at,
    issue: number,
    stage,
    reason: started,
    reauthor,
    mergeQueue,
  };
}

// The window's holder first, then the later stage, Lands in the landing
// order, then the older issue.
function byOrder(
  holder: number | null,
  queue: readonly number[],
): (a: Planned, b: Planned) => number {
  function rank(one: Planned): number {
    const at = queue.indexOf(one.issue.number);
    if (at < 0) {
      return queue.length;
    }
    return at;
  }
  return (a: Planned, b: Planned): number =>
    Number(b.issue.number === holder) - Number(a.issue.number === holder) ||
    STAGE_RANK[a.plan.stage] - STAGE_RANK[b.plan.stage] ||
    rank(a) - rank(b) ||
    Date.parse(a.issue.createdAt) - Date.parse(b.issue.createdAt) ||
    a.issue.number - b.issue.number;
}

// The tick's decisions as of `now`, and the memory after them. `gate` is
// the reason every start is held for, or null when none is.
function schedule(
  snapshot: Snapshot,
  settings: ScheduleSettings,
  run: { now: Date; gate: string | null; resumes: Readonly<Resumes> },
): { decisions: Decision[]; memory: ScheduleMemory } {
  const planned = snapshot.issues.flatMap((issue): Planned[] => {
    const plan = planOf(issue, settings, run.now);
    if (plan.kind === "none") {
      return [];
    }
    return [{ issue, plan }];
  });
  const holder = holderOf(snapshot, planned);
  const liveAt = new Map<Stage, number>();
  let live = 0;
  for (const { job, legacyLive } of snapshot.issues) {
    if (job?.live === true) {
      live += 1;
      liveAt.set(job.stage, (liveAt.get(job.stage) ?? 0) + 1);
    }
    live += Number(legacyLive);
  }
  const count: Count = {
    settings,
    live,
    liveAt,
    holder,
    queue: landingOrderOf(snapshot, planned, holder),
    memory: { resumes: { ...run.resumes }, mergeWindow: holder },
  };
  const at = run.now.toISOString();
  const decisions = planned
    .sort(byOrder(holder, count.queue))
    .map((one) => decide(count, one, { at, gate: run.gate }));
  return { decisions, memory: count.memory };
}

export type { Decision, ScheduleMemory };
export { schedule };
