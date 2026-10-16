// Where a start or restart picks up an issue's machine state from: a claim's
// start state, and the adoption of a push whose state save failed.
import type { PushRecord } from "./checkouts.ts";
import type { State } from "./state.ts";
import { newState } from "./state.ts";

const STAMP_LENGTH = 16;
// How much of a head the log names.
const LOG_SHA_LENGTH = 8;

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

// The plan and spec carry over, except after answered questions.
function carriedWork(state: State | null, answered: boolean): State {
  if (answered || state === null) {
    return {};
  }
  const { plan, spec } = state;
  if (spec === undefined || spec === null || spec === "") {
    return { plan: plan ?? null };
  }
  return { plan: plan ?? null, spec };
}

function carriedReview(state: State | null, stands: boolean): State {
  if (!stands || state === null) {
    return {};
  }
  const { findings, resolvedHistory, reviewedSha } = state;
  return { findings, resolvedHistory: resolvedHistory ?? [], reviewedSha };
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
    rebaseAllocated: 0,
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

// The state a start begins from (Autumn, 2026-10-15). Every start finds the
// issue's open PR by its branch name. When the branch holds work, the start
// continues it at review with every limit reset, the token budget included,
// whatever stopped it, except a too-large stop (#283); when nobody pushed since
// the review, the worktree kept no unpushed commits past the branch and no
// blocking finding is open, the review stands and it goes straight to sync. The plan and spec carry over, except after answered
// questions, which may change them. Commits on the wiki's agent/issue-<n> count
// as work too, so a start may continue at review with no PR. With no work (no
// open PR with code changes and no wiki-branch commits), or after a too-large
// stop, whose half-built spec shouldn't be reviewed, it goes back to triage,
// which reads the implementer's handoff, keeping the PR, and the implementer
// builds on the branch as it is. An issue stopped at publish, after its PR
// merged, resumes there.
function startState(state: State | null, start: StartContext): State {
  const { answered, n, pr, remote } = start;
  const hasWork = continuesWork(state, start);
  if (state !== null && stoppedAtPublish(state, answered)) {
    return resumedPublish(state, start);
  }
  const log = state?.log ?? [];
  const finished = state?.stage === "stopped" || state?.stage === "done";
  if (state !== null && !answered && !finished) {
    return state;
  }
  const fresh = newState(n, state?.depth ?? start.depth);
  if (!hasWork) {
    // Answered questions keep their counters (triages); a stop or a lost
    // state starts fresh.
    if (answered && state !== null) {
      return { ...state, pr: pr ?? state.pr ?? null, stage: "triage" };
    }
    const implemented = state?.implemented;
    const keptPr = pr ?? state?.pr ?? null;
    return { ...fresh, headSha: remote, implemented, log, pr: keptPr };
  }
  const stands = reviewStands(state, start);
  let stage = "review";
  if (stands) {
    stage = "sync";
  }
  let onPr = "no PR";
  if (pr !== null) {
    onPr = `PR #${pr}`;
  }
  const entry = `${stamp(start.now)} restarted on the existing branch (${onPr}) at ${stage} after ${restartReason(state, answered)}; limits reset`;
  return {
    ...fresh,
    headSha: remote,
    implemented: true,
    pr,
    stage,
    ...carriedWork(state, answered),
    ...carriedReview(state, stands),
    log: [...log, entry],
  };
}

// The ops whose pushes are adopted: the syncs with the base branch, which push
// a head made from one the reviews already passed. Every other push (start-pr,
// open-pr, a fix's or a CI fix's push) is followed by a review that adoption
// would skip.
const ADOPTABLE_OPS: ReadonlySet<string> = new Set([
  "sync-base",
  "finish-sync",
]);

// The stages after review, from which an adopted head can go back to sync
// without skipping the code review.
const ADOPTABLE_STAGES: ReadonlySet<unknown> = new Set([
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);

// The saved state with the branch head the pipeline pushed itself adopted, for
// when the push landed but the state save after it failed: the saved head is
// set, and `remote` differs from it but is the head this machine recorded
// pushing (`pushed`). The adopted head goes back through sync and every check
// after it. Only a sync's push, from a state saved at sync or later, is
// adopted: any other push sent to sync would skip the review that follows it,
// so it still stops with branch-changed. Null when there is nothing to adopt
// or the head isn't the pipeline's own sync.
function adoptPush(
  saved: State,
  remote: string | null,
  pushed: PushRecord | null,
  now: Date,
): State | null {
  const { headSha, stage } = saved;
  const known = headSha !== undefined && headSha !== null;
  if (!known || remote === null || remote === headSha || pushed === null) {
    return null;
  }
  if (remote !== pushed.sha || !ADOPTABLE_OPS.has(pushed.op)) {
    return null;
  }
  if (!ADOPTABLE_STAGES.has(stage)) {
    return null;
  }
  const entry = `${stamp(now)} adopted the pipeline's own push ${remote.slice(0, LOG_SHA_LENGTH)}; its state save had failed`;
  return {
    ...saved,
    headSha: remote,
    passedSha: null,
    stage: "sync",
    log: [...(saved.log ?? []), entry],
  };
}

export type { StartContext };
export { adoptPush, startState };
