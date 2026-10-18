// Where a restart after a stop resumes (`every-role-resumes`, Axlog,
// 2026-10-16): the stage that stopped, so no finished stage runs again, with
// the limits reset, and whether the review still stands. Pure; start-state.ts
// builds the state around it.
import type { State } from "./state.ts";

const SHORT_SHA = 12;

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
// The stages after the code review, which stand only on a review of the head
// or of changes with the same patch id (review-keeps-on-clean-rebase).
const AFTER_REVIEW: ReadonlySet<unknown> = new Set([
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);
// The stages after checks, which run only on the head checks verified.
const ON_VERIFIED_HEAD: ReadonlySet<unknown> = new Set([
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
// The role machines' counts are in their checkpoints (checkpointsReset in
// start-state.ts).
const LIMITS_RESET: State = {
  triages: 0,
  continuations: {},
  round: 0,
  ciFixes: 0,
  syncs: 0,
  conflictFixes: 0,
  securityRounds: 0,
};

// True when a stop saved with `stoppedStage` resumes when it is lifted: a
// claim with no answered questions restarts the issue there (or at review,
// when the review no longer stands), as `every-role-resumes` promises. False
// for a missing or malformed stage, and for one a restart doesn't resume.
function resumesAfterStop(stoppedStage: unknown): stoppedStage is string {
  return RESUMABLE.has(stoppedStage) || stoppedStage === "publish";
}

// What a restart finds that decides whether the review stands: the branch's
// head, the patch id of its changes (null when it has none), whether the
// worktree kept commits the branch lacks (#283), and answered questions.
interface BranchFacts {
  remote: string | null;
  patchId: string | null;
  keptUnpushed: boolean;
  answered: boolean;
}

// True when the branch's head is the reviewed one, or its changes have the
// patch id the review passed (review-keeps-on-clean-rebase), the worktree
// kept no unreviewed commits past the branch, no questions were answered and
// no blocking finding is open. A start with no code branch (wiki-only work)
// has no reviewed head to stand on.
function reviewStands(state: State | null, branch: BranchFacts): boolean {
  if (branch.answered || branch.keptUnpushed || state === null) {
    return false;
  }
  const { patchId, remote } = branch;
  const { reviewedSha, reviewedPatchId } = state;
  const unchanged = patchId !== null && patchId === reviewedPatchId;
  return (
    remote !== null &&
    (remote === reviewedSha || unchanged) &&
    !hasOpenFinding(state)
  );
}

// What a restart's log entry adds when the review stands on a head other
// than the reviewed one, so on its unchanged patch id; nothing otherwise.
function keptNote(state: State | null, branch: BranchFacts): string {
  const { reviewedSha } = state ?? {};
  if (typeof reviewedSha !== "string" || branch.remote === reviewedSha) {
    return "";
  }
  if (!reviewStands(state, branch)) {
    return "";
  }
  const since = reviewedSha.slice(0, SHORT_SHA);
  return `; review kept: changes unchanged since ${since}`;
}

// True when the issue has a blocking finding open.
function hasOpenFinding(state: State): boolean {
  return (state.findings ?? []).some((finding) => finding.status === "open");
}

// What a restart knows of the issue: whether its review stands, whether it
// has a spec, and the branch's head.
interface Resume {
  stands: boolean;
  specced: boolean;
  head: string | null;
}

// The stage a restart after a stop at `stopped` resumes at: the same one, so
// no finished stage runs again (`every-role-resumes`). A stage after review
// stands only on a review of the branch's head or of changes with the same
// patch id (review-keeps-on-clean-rebase), so without one it goes back to
// review; one that runs on the verified head resumes at checks when the head
// moved since verification. A review or fix that stands goes on to sync. A
// stage that needs a spec, in a state saved without one, goes back to spec.
function resumedStage(state: State, stopped: string, resume: Resume): string {
  const { stands, specced, head } = resume;
  const { verifiedSha } = state;
  if (NEEDS_SPEC.has(stopped) && !specced) {
    return "spec";
  }
  if (BEFORE_REVIEW.has(stopped)) {
    return stopped;
  }
  if (AFTER_REVIEW.has(stopped) && !stands) {
    return "review";
  }
  if (ON_VERIFIED_HEAD.has(stopped) && head !== verifiedSha) {
    return "checks";
  }
  if (AFTER_REVIEW.has(stopped)) {
    return stopped;
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
// review, which starts with no findings, numbers them from the first, and
// keeps no reviewed or accepted head or patch id (an undefined key is
// dropped from the state).
function keptReview(stage: string, stands: boolean): State {
  if (stage !== "review" || stands) {
    return {};
  }
  return {
    findings: [],
    resolvedHistory: [],
    reviewedSha: null,
    reviewedPatchId: null,
    acceptedSha: null,
    acceptedPatchId: null,
    nextFindingId: undefined,
  };
}

export type { BranchFacts, Resume };
export {
  keptNote,
  keptReview,
  LIMITS_RESET,
  RESUMABLE,
  resumedStage,
  resumesAfterStop,
  reviewStands,
};
