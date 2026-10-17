// Where a start or restart picks up an issue's machine state from: a claim's
// start state. The adoption of a push whose state save failed is in
// adopt-push.ts, and where a stop resumes in resume-stage.ts.
import {
  keptReview,
  LIMITS_RESET,
  RESUMABLE,
  resumedStage,
} from "./resume-stage.ts";
import type { State } from "./state.ts";
import { newState } from "./state.ts";

const STAMP_LENGTH = 16;

// Where a start finds the issue: its branch head, open PR, whether the
// branch holds work, and whether the worktree kept commits the branch lacks
// (#283).
interface StartContext {
  n: number;
  depth: number;
  remote: string | null;
  pr: number | null;
  hasWork: boolean;
  keptUnpushed: boolean;
  answered: boolean;
  now: Date;
}

function stamp(now: Date): string {
  return `${now.toISOString().slice(0, STAMP_LENGTH)}Z`;
}

// Why a start restarts on the branch, for the state's log.
function restartReason(state: State | null, answered: boolean): string {
  if (answered) {
    return "answered questions";
  }
  if (state === null) {
    return "a lost state";
  }
  const { stopCode } = state;
  if (typeof stopCode === "string" && stopCode !== "") {
    return `the ${stopCode} stop`;
  }
  return `the ${String(state.stage)} state`;
}

// True when nobody pushed since the review, the worktree kept no unreviewed
// commits past the branch, and no blocking finding is open. A start with no
// code branch (wiki-only work) has no reviewed head to stand on.
function reviewStands(state: State | null, start: StartContext): boolean {
  if (start.answered || start.keptUnpushed) {
    return false;
  }
  return (
    state !== null &&
    start.remote !== null &&
    start.remote === state.reviewedSha &&
    !(state.findings ?? []).some((finding) => finding.status === "open")
  );
}

// `fields` without those it lacks, so a restart adds no undefined keys.
function present(fields: State): State {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

// The plan and spec carry over, with the spec's full-text path, the files it
// touches, which the orchestrator's file holds read, and whether its writer
// wrote its tests, except after answered questions.
function carriedWork(state: State | null, answered: boolean): State {
  if (answered || state === null) {
    return {};
  }
  const { plan: saved, spec, specFile, files, specWritesTests } = state;
  const plan = saved ?? null;
  if (spec === undefined || spec === null || spec === "") {
    return { plan };
  }
  return present({ plan, spec, specFile, files, specWritesTests });
}

// True when the carried work holds a spec.
function hasSpec(work: State): boolean {
  const { spec } = work;
  return typeof spec === "string" && spec !== "";
}

// What a stop's restart keeps, on the branch or back at triage: the PR's
// description, for an open-pr that reopens it, and the tokens the issue's
// sessions reported.
function carriedRecord(state: State | null): State {
  if (state === null) {
    return {};
  }
  const { prTitle, prBody, prBy, reportedTokens } = state;
  return present({
    prTitle,
    prBody,
    prBy,
    reportedTokens: reportedTokens ?? 0,
  });
}

// A standing review keeps its findings and the counter that numbers the next.
function carriedReview(state: State | null, stands: boolean): State {
  if (!stands || state === null) {
    return {};
  }
  const { findings, nextFindingId, resolvedHistory, reviewedSha } = state;
  const kept = { findings, resolvedHistory: resolvedHistory ?? [] };
  return present({ ...kept, nextFindingId, reviewedSha });
}

// Whether the issue stopped at publish, after its PR merged, with no answered
// questions to act on.
function stoppedAtPublish(state: State, answered: boolean): boolean {
  const { stage, stoppedStage } = state;
  return !answered && stage === "stopped" && stoppedStage === "publish";
}

// A stop after the merge: the code is on the base branch and only the wiki
// changes wait, so the start resumes at publish with the conflict limits and
// the stop cleared, and everything else kept.
function resumedPublish(state: State, start: StartContext): State {
  const { log } = state;
  const entry = `${stamp(start.now)} restarted at publish after ${restartReason(state, false)}; conflict limits reset`;
  return {
    ...state,
    stage: "publish",
    conflictFixes: 0,
    stopCode: null,
    stopReason: null,
    log: [...(log ?? []), entry],
  };
}

// True when the start continues the work its branch holds: there is some,
// and the issue didn't stop as too large for one implementer session (#283).
function continuesWork(state: State | null, start: StartContext): boolean {
  if (!start.hasWork || state === null) {
    return start.hasWork;
  }
  const { stage, stopCode } = state;
  return stage !== "stopped" || stopCode !== "too-large";
}

// The role checkpoints a restart after a stop keeps: the spec writer's start
// heads, the targets its resets go back to and the heads its task lists the
// stage's commits since. Fresh heads would be the branch's current ones, so a
// reset would keep a failed session's commits.
const KEPT_CHECKPOINTS: ReadonlySet<string> = new Set([
  "startSha",
  "startWikiSha",
]);

// A role's checkpoints with only KEPT_CHECKPOINTS left, as a restart after a
// stop resets the limits (#335): every other checkpoint is a count that
// bounds a loop (the spec writer's `attempts` and `continuations`), which
// reads as 0 when missing, so the limit that stopped the issue doesn't stop
// it again before a session runs.
function checkpointsReset(state: State): State["checkpoints"] {
  const { checkpoints } = state;
  if (checkpoints === undefined) {
    return undefined;
  }
  const kept = Object.entries(checkpoints).filter(([name]) =>
    KEPT_CHECKPOINTS.has(name),
  );
  return Object.fromEntries(kept);
}

// A restart after a stop, with no answered questions: it carries the saved
// state and resumes at the stage that stopped, with the stop cleared and
// every limit reset (`every-role-resumes`, Axlog, 2026-10-16). A specced
// issue doesn't go through triage and spec again. Null when the state names
// no stage it stopped in, so the start begins as before.
function resumedStop(state: State | null, start: StartContext): State | null {
  if (state === null || start.answered || state.stage !== "stopped") {
    return null;
  }
  const { stoppedStage } = state;
  if (typeof stoppedStage !== "string" || !RESUMABLE.has(stoppedStage)) {
    return null;
  }
  const work = carriedWork(state, false);
  const stands = reviewStands(state, start);
  const stage = resumedStage(state, stoppedStage, stands, hasSpec(work));
  const entry = `${stamp(start.now)} restarted at ${stage} after ${restartReason(state, false)}; limits reset`;
  const resumed: State = present({
    ...state,
    ...work,
    ...LIMITS_RESET,
    ...keptReview(stage, stands),
    checkpoints: checkpointsReset(state),
    stage,
    headSha: start.remote,
    pr: start.pr ?? state.pr ?? null,
    stopCode: null,
    stopReason: null,
    stoppedStage: null,
    log: [...(state.log ?? []), entry],
  });
  if (!hasSpec(work)) {
    return { ...resumed, spec: null, specFile: null };
  }
  return resumed;
}

// The state a start begins from (Autumn, 2026-10-15). Every start finds the
// issue's open PR by its branch name. An issue stopped at publish, after its
// PR merged, resumes there. Any other stop resumes at the stage it stopped
// in, carrying the saved state, with every limit reset (resumedStop,
// `every-role-resumes`). Without a stage to resume (a lost state, a finished
// one, or answered questions): when the branch holds work, the start
// continues it at review with every limit reset, or at sync when nobody pushed
// since the review, the worktree kept no unpushed commits past the branch and
// no blocking finding is open. The plan and spec carry over, except after
// answered questions, which may change them. Commits on the wiki's
// agent/issue-<n> count as work too, so a start may continue at review with
// no PR. With no work, a specced issue goes to
// implement and builds on the branch as it is; one with no spec goes back to
// triage, which reads the implementer's handoff, keeping the PR.
function startState(state: State | null, start: StartContext): State {
  const { answered } = start;
  if (state !== null && stoppedAtPublish(state, answered)) {
    return resumedPublish(state, start);
  }
  const finished = state?.stage === "stopped" || state?.stage === "done";
  if (state !== null && !answered && !finished) {
    return state;
  }
  const resumed = resumedStop(state, start);
  if (resumed !== null) {
    return resumed;
  }
  if (!continuesWork(state, start)) {
    return noWorkStart(state, start);
  }
  return branchStart(state, start);
}

// A start with no work on the branch: answered questions go back to triage
// with their counters (triages); a specced issue goes to implement; anything
// else starts fresh at triage. Both keep carriedRecord.
function noWorkStart(state: State | null, start: StartContext): State {
  const { answered, n, pr, remote } = start;
  if (answered && state !== null) {
    return { ...state, pr: pr ?? state.pr ?? null, stage: "triage" };
  }
  const log = state?.log ?? [];
  const fresh = newState(n, state?.depth ?? start.depth);
  const implemented = state?.implemented;
  const keptPr = pr ?? state?.pr ?? null;
  const kept = { headSha: remote, implemented, log, pr: keptPr };
  const base = { ...fresh, ...carriedRecord(state), ...kept };
  const work = carriedWork(state, answered);
  if (!hasSpec(work)) {
    return base;
  }
  const entry = `${stamp(start.now)} restarted at implement with the saved spec after ${restartReason(state, answered)}`;
  return { ...base, ...work, stage: "implement", log: [...log, entry] };
}

// A start that continues the branch's work at review, or at sync when the
// review stands.
function branchStart(state: State | null, start: StartContext): State {
  const { answered, n, pr, remote } = start;
  const stands = reviewStands(state, start);
  let stage = "review";
  if (stands) {
    stage = "sync";
  }
  let onPr = "no PR";
  if (pr !== null) {
    onPr = `PR #${pr}`;
  }
  const log = state?.log ?? [];
  const entry = `${stamp(start.now)} restarted on the existing branch (${onPr}) at ${stage} after ${restartReason(state, answered)}; limits reset`;
  return {
    ...newState(n, state?.depth ?? start.depth),
    headSha: remote,
    implemented: true,
    pr,
    stage,
    ...carriedRecord(state),
    ...carriedWork(state, answered),
    ...carriedReview(state, stands),
    log: [...log, entry],
  };
}

export type { StartContext };
export { startState };
