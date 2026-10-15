// An issue's machine state: one hidden comment per issue that only the
// pipeline's account writes, and where a start or restart picks up from.

import { z } from "zod";
import type { PushRecord } from "./checkouts.ts";
import type { IssueComment } from "./comments.ts";
import { listComments, rawComment, STATE_MARK } from "./comments.ts";
import type { Config } from "./config.ts";
import { gh } from "./github.ts";
import { OpsError } from "./process.ts";

const MARK_END = "-->";
const MARK_END_PATTERN = /-->/gu;
const ESCAPED_MARK_END = "--\\u003e";
// Leaves room under GitHub's comment limit for the header and footer.
const MAX_STATE_LENGTH = 60_000;
const STAMP_LENGTH = 16;
// How much of a head the log names.
const LOG_SHA_LENGTH = 8;

// The fields the ops modules read; the workflow owns the rest, which pass
// through unchanged.
const STATE = z.looseObject({
  depth: z.number().optional(),
  findings: z.array(z.looseObject({ status: z.unknown() })).nullish(),
  headSha: z.string().nullish(),
  log: z.array(z.unknown()).nullish(),
  implemented: z.unknown().optional(),
  pr: z.unknown().optional(),
  reviewedSha: z.unknown().optional(),
  stage: z.string().optional(),
});

type State = z.infer<typeof STATE>;

interface StoredState {
  id: number | null;
  state: State | null;
}

// Where a start finds the issue: its branch head, open PR and whether the
// branch holds work.
interface StartContext {
  n: number;
  depth: number;
  remote: string | null;
  pr: number | null;
  hasWork: boolean;
  answered: boolean;
  now: Date;
}

// The state in a state comment's body, or null when it has none or it is
// unreadable.
function parseStateBody(body: string): State | null {
  const start = body.indexOf(STATE_MARK);
  const end = body.indexOf(MARK_END, start);
  if (start < 0 || end < 0) {
    return null;
  }
  try {
    const parsed = STATE.safeParse(
      JSON.parse(body.slice(start + STATE_MARK.length, end)),
    );
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

function readState(
  cfg: Config,
  number: number,
  comments?: readonly IssueComment[],
): StoredState {
  // Only trust a state comment written by the pipeline's account. Anyone can
  // paste the marker.
  const mine = (comments ?? listComments(cfg, number)).filter(
    (item) =>
      item.user?.login === cfg.account &&
      (item.body ?? "").includes(STATE_MARK),
  );
  const latest = mine.at(-1);
  if (latest === undefined) {
    return { id: null, state: null };
  }
  return { id: latest.id, state: parseStateBody(latest.body ?? "") };
}

function writeState(cfg: Config, number: number, state: unknown): void {
  const json = JSON.stringify(state).replace(
    MARK_END_PATTERN,
    ESCAPED_MARK_END,
  );
  const body = `**🤖 issue-pipeline · state**\n${STATE_MARK}\n${json}\n-->\n<sub>Machine state for #${number}. The pipeline rewrites this comment; do not edit it.</sub>`;
  if (body.length > MAX_STATE_LENGTH) {
    throw new OpsError(
      `state for #${number} is too large (${body.length} chars)`,
    );
  }
  const { id } = readState(cfg, number);
  if (id === null) {
    rawComment(cfg, number, body);
    return;
  }
  gh(cfg, [
    "api",
    "-X",
    "PATCH",
    `repos/${cfg.repo}/issues/comments/${id}`,
    "-f",
    `body=${body}`,
    "--silent",
  ]);
}

function newState(number: number, depth: number): State {
  return {
    version: 1,
    number,
    depth,
    stage: "triage",
    lease: null,
    pr: null,
    headSha: null,
    reviewedSha: null,
    verifiedSha: null,
    plan: null,
    allocated: 0,
    rebaseAllocated: 0,
    rechecking: false,
    reportedTokens: 0,
    sessions: [],
    triages: 0,
    continuations: 0,
    round: 0,
    ciFixes: 0,
    syncs: 0,
    findings: [],
    resolvedHistory: [],
    questionsAt: null,
    log: [],
  };
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

// True when nobody pushed since the review and no blocking finding is open.
function reviewStands(state: State | null, start: StartContext): boolean {
  return (
    !start.answered &&
    state !== null &&
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

// The state a start begins from (Autumn, 2026-10-15). Every start finds the
// issue's open PR by its branch name. When the branch holds work, the start
// continues it at review with every limit reset, the token budget included,
// whatever stopped it; when nobody pushed since the review and no blocking
// finding is open, the review stands and it goes straight to sync. The plan and
// spec carry over, except after answered questions, which may change them. With
// no open PR or no work on the branch, it goes back to triage, and the
// implementer builds on the branch as it is.
function startState(state: State | null, start: StartContext): State {
  const { answered, hasWork, n, pr, remote } = start;
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
  const entry = `${stamp(start.now)} restarted on the existing branch (PR #${pr}) at ${stage} after ${restartReason(state, answered)}; limits reset`;
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

export type { StartContext, State, StoredState };
export {
  adoptPush,
  newState,
  parseStateBody,
  readState,
  STATE,
  startState,
  writeState,
};
