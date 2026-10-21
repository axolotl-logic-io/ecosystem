// What one open issue needs next, before caps, the merge window and restarts:
// nothing, a hold with its reason, or a job at a stage. Pure.
//
// - Not scheduled: a stop label, agent:merged, a skipLabels label, an author
//   who isn't an allowed collaborator, a split parent (the tick closes it), a
//   state at `done`, a live job, or new work while takeNewWork is false.
// - A completion (`completion-reconciliation`): an open issue saved `done`
//   with its merged revision, which the finish op hasn't closed, runs a merge
//   job that only finishes it, even with agent:merged already set. The
//   merge role, not a re-author here, sends new trusted input to the author.
// - Held: a legacy job still running, another lane's live lease, an open
//   prerequisite in its after mark (`prerequisite-holds`), or questions asked
//   on the trusted inputs it still has (`agent:needs-info`).
// - Re-authored (`trusted-inputs-revision`): an issue past `author` whose
//   Gherkin comment is missing or was written from other trusted inputs goes
//   back to the author, returning to `implement` from implement and to
//   `review` from review or merge. Only trusted human input changes that
//   revision, so a visitor's or the pipeline's comment never wakes the author.
// - A stopped issue whose stop label is gone runs at the stage it stopped in.

import { LABELS } from "../labels.ts";
import {
  requirementsStage,
  requirementsState,
  usedAuthor,
} from "../requirements.ts";
import type { Stage } from "../stages.ts";
import { isStage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { resumeOf, withLog } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import type { ScheduleSettings, SnapshotIssue } from "./queue.ts";

// The lane every orchestrator job claims in, so its own lease never holds it.
const ORCHESTRATOR_LANE = "orchestrator";

// Why a job starts: a stage due, a lifted stop, or new trusted input.
type StartReason = "free" | "lifted" | "reauthor";

// The state the tick saves before it starts the author on new input: the
// issue at `author`, to go on at `resumeStage` when the Gherkin is unchanged.
interface Reauthor {
  resumeStage: "implement" | "review" | null;
}

type IssuePlan =
  | { kind: "none" }
  | { kind: "held"; stage: Stage; reason: string }
  | {
      kind: "run";
      stage: Stage;
      reason: StartReason;
      reauthor: Reauthor | null;
    };

const NONE: IssuePlan = { kind: "none" };

// True for a completion the merge role saved: done, with what merged.
function isCompletion(state: IssueState | null): boolean {
  return state?.stage === "done" && state.merged !== null;
}

// True when the issue isn't the orchestrator's to schedule at all.
function unscheduled(
  issue: SnapshotIssue,
  settings: ScheduleSettings,
): boolean {
  const labels = new Set(issue.labels);
  const completion = isCompletion(issue.state);
  return (
    issue.labels.some(isStopLabel) ||
    (labels.has(LABELS.merged.name) && !completion) ||
    labels.has(LABELS.split.name) ||
    settings.skipLabels.some((label) => labels.has(label)) ||
    !issue.authorAllowed ||
    (issue.state?.stage === "done" && !completion) ||
    issue.job?.live === true ||
    (issue.state === null && !settings.takeNewWork)
  );
}

// The lane of a live lease another claimant holds, or null.
function otherLane(
  state: IssueState | null,
  now: Date,
  leaseMs: number,
): string | null {
  const lease = state?.lease ?? null;
  if (lease === null || now.getTime() - Date.parse(lease.at) >= leaseMs) {
    return null;
  }
  const lane = lease.lane ?? lease.sweepId ?? null;
  if (lane === ORCHESTRATOR_LANE) {
    return null;
  }
  return lane ?? "unnamed";
}

// The stage after the author for an issue sent back from `stage`.
function resumeStageFor(
  stage: Exclude<Stage, "author">,
): "implement" | "review" {
  switch (stage) {
    case "implement":
      return "implement";
    case "review":
    case "merge":
      return "review";
    default: {
      const unknown: never = stage;
      throw new Error(`unknown stage ${String(unknown)}`);
    }
  }
}

// The stage the issue's next job runs: author with no state, the stopped
// stage of a lifted stop, merge for a completion, else its saved stage;
// null for a saved `done` with nothing merged.
function stageOf(state: IssueState | null): Stage | null {
  if (state === null) {
    return "implement";
  }
  if (isCompletion(state)) {
    return "merge";
  }
  const { stage } = resumeOf(state);
  if (isStage(stage)) {
    return stage;
  }
  return null;
}

// Why the issue is held at `stage` before its inputs are compared, or null.
function holdReason(
  issue: SnapshotIssue,
  settings: ScheduleSettings,
  now: Date,
): string | null {
  if (issue.legacyLive) {
    return "legacy-job-live";
  }
  const lane = otherLane(issue.state, now, settings.leaseMs);
  if (lane !== null) {
    return `lease:${lane}`;
  }
  const [prereq] = issue.after;
  if (prereq !== undefined && !isCompletion(issue.state)) {
    return `after:#${prereq}`;
  }
  return null;
}

// The issue's plan as of `now`.
function planOf(
  issue: SnapshotIssue,
  settings: ScheduleSettings,
  now: Date,
): IssuePlan {
  if (unscheduled(issue, settings)) {
    return NONE;
  }
  const { state, inputs } = issue;
  if (inputs === null) {
    return NONE;
  }
  const stage = stageOf(state);
  if (stage === null) {
    return NONE;
  }
  const held = holdReason(issue, settings, now);
  if (held !== null) {
    return { kind: "held", stage, reason: held };
  }
  let reason: StartReason = "free";
  if (isCompletion(state)) {
    return { kind: "run", stage, reason, reauthor: null };
  }
  if (state?.stage === "stopped") {
    reason = "lifted";
  }
  if (
    issue.labels.includes(LABELS.needsInfo.name) &&
    inputs.asked === inputs.current
  ) {
    return { kind: "held", stage, reason: "needs-info" };
  }
  if (state === null || stage === "author") {
    return { kind: "run", stage, reason, reauthor: null };
  }
  let consumed = state.requirementsInputs;
  if (usedAuthor(state)) {
    consumed = inputs.gherkin;
  }
  if (consumed !== inputs.current) {
    return {
      kind: "run",
      stage: requirementsStage(state),
      reason: "reauthor",
      reauthor: { resumeStage: resumeStageFor(stage) },
    };
  }
  return { kind: "run", stage, reason, reauthor: null };
}

// The state the tick saves before its requirements owner reads new input, from
// the state read again just before (`fresh`) and the one the plan saw
// (`seen`), or the reason it holds the start instead: the state changed
// since, or another claimant's lease went live. Revision-bound authorizations
// are invalidated; the lease and saved work remain. The requirements owner
// records the input revision only after reading it.
function reauthoredState(
  states: { fresh: IssueState | null; seen: IssueState | null },
  reauthor: Reauthor,
  run: { now: Date; leaseMs: number },
): { kind: "save"; state: IssueState } | { kind: "held"; reason: string } {
  const { fresh, seen } = states;
  if (fresh === null || fresh.stage !== seen?.stage) {
    return { kind: "held", reason: "state-changed" };
  }
  const lane = otherLane(fresh, run.now, run.leaseMs);
  if (lane !== null) {
    return { kind: "held", reason: `lease:${lane}` };
  }
  const lifted = resumeOf(fresh);
  const { resumeStage } = reauthor;
  const entry = `trusted inputs changed at ${lifted.stage}: back to ${requirementsStage(lifted)}`;
  const back = requirementsState(lifted, resumeStage ?? "implement");
  return { kind: "save", state: withLog(back, entry, run.now) };
}

export type { IssuePlan, Reauthor, StartReason };
export { isCompletion, ORCHESTRATOR_LANE, planOf, reauthoredState };
