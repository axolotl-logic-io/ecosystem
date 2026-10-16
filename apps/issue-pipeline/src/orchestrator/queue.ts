// The queue the orchestrator schedules (#234): the snapshot of the open
// issues and their jobs, what each issue's facts mean (the stage its next job
// runs, its file set, whether it is live, waiting or a live implementation),
// and the order the merge-ready issues should merge in. Pure.

import { fileSetsOverlap } from "../globs.ts";
import { READY_STAGES } from "../ops/merge-order.ts";
import { STAGE_ORDER } from "../workflow/sweep-config.ts";

// How the sweep's classify judged the issue, as far as scheduling cares.
type IssueVerdict =
  | { kind: "candidate"; answered: boolean }
  | { kind: "waiting-on-after" }
  | { kind: "live-elsewhere"; lane: string }
  | { kind: "skip" };

// The issue an issue's branch is stacked on (#268), and the head of its
// branch it was last put on.
interface StackedOn {
  issue: number;
  headSha: string;
}

// The issue's prerequisite (#290), as far as scheduling cares: the issue it
// is stacked on, or, when it isn't stacked, the one open issue its after mark
// names. An open prerequisite carries its stage, how many of its findings are
// open, its branch head, whether it is stacked itself and whether it is
// stopped; one whose PR merged, at publish or closed, has merged.
type Prereq =
  | {
      number: number;
      status: "open";
      stage: string;
      openFindings: number;
      headSha: string | null;
      stacked: boolean;
      stopped: boolean;
    }
  | { number: number; status: "merged" }
  | { number: number; status: "closed-unmerged" };

// The issue's stage job: whether it runs, and the stage it began.
interface IssueJob {
  live: boolean;
  stage: string;
}

interface SnapshotIssue {
  number: number;
  createdAt: string;
  verdict: IssueVerdict;
  // The stage its saved state names, or null with no state.
  stage: string | null;
  // The paths or globs the spec says it touches (st.files).
  files: readonly string[] | null;
  pr: number | null;
  // The issues its after mark names.
  after: readonly number[];
  stopped: boolean;
  job: IssueJob | null;
  stackedOn: StackedOn | null;
  prereq: Prereq | null;
}

interface Snapshot {
  issues: readonly SnapshotIssue[];
  // The tokens the jobs spent in the last hour (the ledger's count).
  spentLastHour: number;
}

interface ScheduleSettings {
  maxJobs: number;
  stageCaps: Readonly<Record<string, number>>;
  tokensPerHour: number;
}

const STAGE_AT: ReadonlyMap<string, number> = new Map(
  STAGE_ORDER.map((name, at): [string, number] => [name, at]),
);
const IMPLEMENT = STAGE_ORDER.indexOf("implement");
const WRITERS: ReadonlySet<string> = new Set([
  "implement",
  "fix",
  "sync",
  "checks",
]);
const WHOLE_REPO: readonly string[] = ["**"];

// The stage's place in STAGE_ORDER, or -1 for another stage (stopped, done).
function stageIndex(stage: string): number {
  return STAGE_AT.get(stage) ?? -1;
}

// The stage the issue's next job runs.
function runStage(issue: SnapshotIssue): string {
  const { stage, verdict } = issue;
  if (stage === null || (verdict.kind === "candidate" && verdict.answered)) {
    return "triage";
  }
  return stage;
}

function fileSet(issue: SnapshotIssue): readonly string[] {
  if (issue.files === null || issue.files.length === 0) {
    return WHOLE_REPO;
  }
  return issue.files;
}

function isLive(issue: SnapshotIssue): boolean {
  return issue.job?.live === true;
}

function isStopped(issue: SnapshotIssue): boolean {
  return issue.stopped || issue.stage === "stopped";
}

// From implement (with a live job) until merge, or until it stops.
function isLiveImplementation(issue: SnapshotIssue): boolean {
  const at = stageIndex(runStage(issue));
  return (
    !isStopped(issue) && (at > IMPLEMENT || (at === IMPLEMENT && isLive(issue)))
  );
}

// Earlier createdAt first, then the lower number: a total order.
function byAge(a: SnapshotIssue, b: SnapshotIssue): number {
  return (
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
  );
}

function isWaiting(issue: SnapshotIssue): boolean {
  const at = stageIndex(runStage(issue));
  return !(isStopped(issue) || isLive(issue)) && at >= 0 && at <= IMPLEMENT;
}

function dependents(
  candidate: SnapshotIssue,
  waiting: readonly SnapshotIssue[],
): number {
  return waiting.filter(
    (issue) =>
      issue.number !== candidate.number &&
      (issue.after.includes(candidate.number) ||
        fileSetsOverlap(fileSet(issue), fileSet(candidate))),
  ).length;
}

// Why the classify verdict alone holds the issue, or null for a candidate.
// Undefined: no decision at all.
function verdictHold(issue: SnapshotIssue): string | null | undefined {
  const { verdict } = issue;
  switch (verdict.kind) {
    case "skip":
      return undefined;
    case "waiting-on-after":
      return `after:#${String(issue.after.at(0))}`;
    case "live-elsewhere":
      return `lane:${verdict.lane}`;
    case "candidate":
      return null;
    default: {
      const unknown: never = verdict;
      throw new Error(`unknown verdict ${JSON.stringify(unknown)}`);
    }
  }
}

// True for a stacked issue whose prerequisite is still open: it can't merge
// until that one has.
function awaitsPrereq(issue: SnapshotIssue): boolean {
  return issue.stackedOn !== null && issue.prereq?.status === "open";
}

// The issues at a merge-ready stage, in the order they should merge: the one
// the most waiting issues depend on first, then the lower PR and number. A
// stacked issue isn't ranked while its prerequisite is open.
function mergeRank(issues: readonly SnapshotIssue[]): number[] {
  const waiting = issues.filter(isWaiting);
  const ranked = issues
    .filter(
      (issue) =>
        !(isStopped(issue) || awaitsPrereq(issue)) &&
        READY_STAGES.has(runStage(issue)),
    )
    .map((issue) => ({ issue, count: dependents(issue, waiting) }));
  ranked.sort(
    (a, b) =>
      b.count - a.count ||
      (a.issue.pr ?? Number.POSITIVE_INFINITY) -
        (b.issue.pr ?? Number.POSITIVE_INFINITY) ||
      a.issue.number - b.issue.number,
  );
  return ranked.map(({ issue }) => issue.number);
}

export type {
  IssueJob,
  IssueVerdict,
  Prereq,
  ScheduleSettings,
  Snapshot,
  SnapshotIssue,
  StackedOn,
};
export {
  awaitsPrereq,
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
};
