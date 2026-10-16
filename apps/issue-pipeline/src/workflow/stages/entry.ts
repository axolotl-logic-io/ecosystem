// The sweep's entry and exit, as pure steps: the sweep op, the claim of each
// candidate in turn, the closing launches (parents, then the release or the
// last comments of the issue), and the summary the sweep returns. The sweep's
// driver (../sweep.ts) runs them around the stages.

import type { IssueState } from "../types.ts";
import {
  isCandidates,
  isIssueState,
  isItemPaths,
  isNumbers,
  isString,
  isSweepConfig,
} from "./entry-replies.ts";
import { closeParentLaunches } from "./parents.ts";
import type {
  AbandonedClaim,
  ClaimStep,
  CleanupLog,
  OpLaunch,
  StageStop,
  SummaryItem,
  SweepReply,
  SweepSummary,
} from "./types.ts";

type Reply = Readonly<Record<string, unknown>>;

const SWEEP_MINUTES = 20;
const CLAIM_MINUTES = 15;
const NO_STATE = "the claim reply had no valid state and paths for the issue";
const WAITING = "waiting for an answer to the pipeline's questions";
const BRANCH_MOVED = "the PR branch changed outside the pipeline";

// The sweep op, for every candidate or only issue `only`.
function sweepLaunch(only: number | null): OpLaunch {
  let payload: Reply = {};
  if (only !== null) {
    payload = { only };
  }
  return {
    kind: "op",
    name: "sweep",
    op: "sweep",
    payload,
    minutes: SWEEP_MINUTES,
  };
}

// The sweep op's reply. A failed or malformed one fails the whole sweep.
function sweepReplyOf(reply: Reply): SweepReply {
  const { ok, error, config, items, waiting, parents } = reply;
  if (ok !== true) {
    throw new Error(`sweep failed: ${String(error)}`);
  }
  if (
    !(
      isSweepConfig(config) &&
      isCandidates(items) &&
      typeof waiting === "number" &&
      isNumbers(parents)
    )
  ) {
    throw new Error("sweep failed: the sweep reply was malformed");
  }
  return { ok, config, items, waiting, parents };
}

// The claim of candidate `n`.
function claimLaunch(n: number): OpLaunch {
  return {
    kind: "op",
    name: `i${n}-claim`,
    op: "claim",
    payload: { number: n },
    minutes: CLAIM_MINUTES,
  };
}

// The text, or null when it is missing, empty or not text.
function textOf(value: unknown): string | null {
  if (isString(value) && value !== "") {
    return value;
  }
  return null;
}

function abandonedOf(n: number, reply: Reply): AbandonedClaim {
  const { holder, posted } = reply;
  return { issue: n, holder: textOf(holder), commented: Boolean(posted) };
}

// The stop for a PR branch whose head isn't the one the state last saw.
function headStop(st: IssueState, remoteHead: unknown): StageStop | null {
  const headSha = textOf(st.headSha);
  const remote = textOf(remoteHead);
  if (headSha === null || remote === null || remote === headSha) {
    return null;
  }
  const detail = `Expected ${headSha}, found ${remote}.`;
  return { reason: BRANCH_MOVED, detail, code: null };
}

// What candidate `n`'s claim reply means for the sweep.
function claimStep(n: number, reply: Reply): ClaimStep {
  const { ok, lost, waiting, error, state, paths, remoteHead } = reply;
  if (ok !== true) {
    return {
      kind: "unclaimed",
      outcome: "claim-failed",
      reason: textOf(error),
    };
  }
  if (waiting === "answer") {
    return {
      kind: "unclaimed",
      outcome: "waiting-for-answer",
      reason: WAITING,
    };
  }
  if (lost === true) {
    return { kind: "lost", abandoned: abandonedOf(n, reply) };
  }
  if (!(isIssueState(state) && isItemPaths(paths))) {
    return { kind: "unclaimed", outcome: "claim-failed", reason: NO_STATE };
  }
  const stop = headStop(state, remoteHead);
  return { kind: "claimed", st: state, paths, stop };
}

// The issue as the sweep closes it: its number, its state if it is still open
// (so it is released for the next sweep), and how many comments it has queued.
interface ClosingItem {
  n: number;
  openState: IssueState | null;
  queued: number;
}

// The parents to close, then the release of an open issue, which carries its
// queued comments, or else an op that only posts them.
function finishLaunches(
  parents: readonly number[],
  item: ClosingItem | null,
): OpLaunch[] {
  const launches = closeParentLaunches(parents);
  if (item === null) {
    return launches;
  }
  const { n, openState, queued } = item;
  const payload = { number: n };
  if (openState !== null) {
    const release = { ...payload, state: openState };
    launches.push({
      kind: "op",
      name: `i${n}-release`,
      op: "release",
      payload: release,
    });
  } else if (queued > 0) {
    launches.push({ kind: "op", name: `i${n}-post`, op: "post", payload });
  }
  return launches;
}

// The save of an open issue at its stage, with no lease, so the next job
// for that stage continues it, when a stop interrupts the sweep; or null
// when there is no open issue to save.
function interruptLaunch(item: ClosingItem | null): OpLaunch | null {
  if (item === null || item.openState === null) {
    return null;
  }
  const { n } = item;
  return {
    kind: "op",
    name: `i${n}-interrupt`,
    op: "save-state",
    payload: { number: n, state: { ...item.openState, lease: null } },
  };
}

// The sweep's issue as its summary reports it.
interface SummarySource {
  n: number;
  st: IssueState | null;
  outcome: string | null;
  reason: string | null;
}

interface SummaryInput {
  sweepId: string;
  lane: string;
  reply: SweepReply;
  abandoned: readonly AbandonedClaim[];
  item: SummarySource | null;
  parentsClosed: number;
  cleanup: CleanupLog;
}

// The state's PR, undefined when the state has no `pr`, or null with no state.
function prOf(st: IssueState | null): number | null | undefined {
  if (st === null) {
    return null;
  }
  return st.pr;
}

// The tokens the state's rebases were given, 0 before any, or null with no
// state.
function rebaseAllocatedOf(st: IssueState | null): number | null {
  if (st === null) {
    return null;
  }
  return st.rebaseAllocated ?? 0;
}

function summaryItem({ n, st, outcome, reason }: SummarySource): SummaryItem {
  return {
    issue: n,
    pr: prOf(st),
    stage: st?.stage ?? null,
    outcome: textOf(outcome) ?? "in-progress",
    reason: textOf(reason),
    allocatedTokens: st?.allocated ?? null,
    rebaseAllocatedTokens: rebaseAllocatedOf(st),
  };
}

function buildSummary(input: SummaryInput): SweepSummary {
  const { sweepId, lane, reply, abandoned, item, parentsClosed, cleanup } =
    input;
  let items: SummaryItem[] = [];
  if (item !== null) {
    items = [summaryItem(item)];
  }
  return {
    sweep: sweepId,
    lane,
    repo: reply.config.repo,
    waiting: reply.waiting,
    abandoned,
    items,
    parentsClosed,
    cleanup,
  };
}

export type { ClosingItem, SummaryInput, SummarySource };
export {
  buildSummary,
  claimLaunch,
  claimStep,
  finishLaunches,
  interruptLaunch,
  sweepLaunch,
  sweepReplyOf,
};
