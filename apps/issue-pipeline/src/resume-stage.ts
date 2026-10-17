// Where a restart after a stop resumes (`every-role-resumes`, Axlog,
// 2026-10-16): the stage that stopped, so no finished stage runs again, with
// the limits reset. Pure; start-state.ts builds the state around it.
import type { State } from "./state.ts";

// The stages in the order an issue goes through them. A restart resumes at
// the one it stopped in (`every-role-resumes`).
const BEFORE_REVIEW: ReadonlySet<unknown> = new Set([
  "triage",
  "spec",
  "implement",
  "open-pr",
]);
// The stages that need a spec.
const NEEDS_SPEC: ReadonlySet<unknown> = new Set(["implement", "open-pr"]);
// The stages after the code review, which stand only on a review of the head.
const AFTER_REVIEW: ReadonlySet<unknown> = new Set([
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);
// The stages a stop resumes in; publish resumes as resumedPublish says.
const RESUMABLE: ReadonlySet<unknown> = new Set([
  ...BEFORE_REVIEW,
  "review",
  "fix",
  ...AFTER_REVIEW,
]);
// The counts that bound a stage's loops. A restart after a stop resets them,
// as the stop comment promises, so the limit that stopped it doesn't at once.
const LIMITS_RESET: State = {
  triages: 0,
  continuations: {},
  round: 0,
  ciFixes: 0,
  syncs: 0,
  conflictFixes: 0,
};

// True when a stop saved with `stoppedStage` resumes when it is lifted: a
// claim with no answered questions restarts the issue there (or at review,
// when the review no longer stands), as `every-role-resumes` promises. False
// for a missing or malformed stage, and for one a restart doesn't resume.
function resumesAfterStop(stoppedStage: unknown): stoppedStage is string {
  return RESUMABLE.has(stoppedStage) || stoppedStage === "publish";
}

// True when the issue has a blocking finding open.
function hasOpenFinding(state: State): boolean {
  return (state.findings ?? []).some((finding) => finding.status === "open");
}

// The stage a restart after a stop at `stopped` resumes at: the same one, so
// no finished stage runs again (`every-role-resumes`). A stage after review
// stands only on a review of the branch's head, so without one it goes back
// to review; a review or fix that stands goes on to sync. A stage that needs
// a spec, in a state saved without one, goes back to spec.
function resumedStage(
  state: State,
  stopped: string,
  stands: boolean,
  specced: boolean,
): string {
  if (NEEDS_SPEC.has(stopped) && !specced) {
    return "spec";
  }
  if (BEFORE_REVIEW.has(stopped)) {
    return stopped;
  }
  if (AFTER_REVIEW.has(stopped) && stands) {
    return stopped;
  }
  if (AFTER_REVIEW.has(stopped)) {
    return "review";
  }
  if (stands) {
    return "sync";
  }
  if (stopped === "fix" && hasOpenFinding(state)) {
    return "fix";
  }
  return "review";
}

// The review a restart at `stage` keeps: all of it unless it goes back to
// review, which starts with no findings and numbers them from the first (an
// undefined key is dropped from the state).
function keptReview(stage: string, stands: boolean): State {
  if (stage !== "review" || stands) {
    return {};
  }
  return {
    findings: [],
    resolvedHistory: [],
    reviewedSha: null,
    nextFindingId: undefined,
  };
}

export { keptReview, LIMITS_RESET, RESUMABLE, resumedStage, resumesAfterStop };
