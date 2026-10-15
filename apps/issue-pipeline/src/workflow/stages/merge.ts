// Merge: merges the verified head through ops, in merge order, once no
// blocking finding is open. A merge that waits for an older PR stays at merge;
// one that must rebase first goes back to sync with its passed head kept. A
// branch behind its base rebases in this sweep, once; after that, and on a
// conflict, it rebases next sweep.

import { noteEvent } from "../event-log.ts";
import { findingsStop, openFindings } from "../findings.ts";
import { acceptanceSummary } from "../summary.ts";
import type { IssueState } from "../types.ts";
import { opFailedStep } from "./network.ts";
import { textOrNull } from "./replies.ts";
import {
  codedStopStep,
  doneStep,
  launchStep,
  onlyReply,
  stopStep,
} from "./step.ts";
import type {
  LaunchResult,
  OpLaunch,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where the merge is: about to ask for it, or reading the answer.
type MergePhase = "begin" | "decide";

const PHASES: readonly MergePhase[] = ["begin", "decide"];

function phaseOf(state: StageState): MergePhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`merge: unknown phase ${state.phase}`);
  }
  return phase;
}

function mergeLaunch(state: StageState, ctx: StageContext): OpLaunch {
  const { st } = state;
  const checks = st.verifySummary ?? "";
  const acceptance = acceptanceSummary(ctx.cfg, state);
  return {
    kind: "op",
    name: "merge",
    op: "merge",
    payload: {
      number: state.n,
      state: st,
      expectedSha: st.verifiedSha,
      mergeOrder: true,
      summary: `Checks: ${checks}\n\nAcceptance: ${acceptance}`,
    },
  };
}

// Stops while a blocking finding is open, or asks ops to merge.
function begin(state: StageState, ctx: StageContext): Step {
  if (openFindings(state).length > 0) {
    const base = "open blocking findings remain at merge time";
    return codedStopStep(state, findingsStop(ctx.cfg, state, base));
  }
  return launchStep({ ...state, phase: "decide" }, [mergeLaunch(state, ctx)]);
}

// An older PR is ready too and merges first (decision merge-order). If it
// lands first, the next merge attempt reports "behind" and this one rebases.
// The note is logged once while the wait lasts.
function queued(
  state: StageState,
  ctx: StageContext,
  reply: Readonly<Record<string, unknown>>,
): Step {
  const { waitingFor, waitingForPr } = reply;
  const note = `merge waits for #${String(waitingFor)} (older PR #${String(waitingForPr)})`;
  const last = (state.st.log ?? []).at(-1) ?? "";
  if (last.includes(note)) {
    return doneStep(state);
  }
  const st = { ...state.st };
  noteEvent(st, note, ctx.now());
  return doneStep({ ...state, st });
}

// The issue's saved state sent back to sync, with its passed head kept.
function backToSync(state: StageState): IssueState {
  return {
    ...state.st,
    passedSha: state.st.verifiedSha ?? null,
    stage: "sync",
  };
}

// This head passed every check, acceptance and the security review, and is
// only behind its base, so sync rebases it in this sweep. A behind branch
// rebases this way once per sweep.
function resyncNow(state: StageState, ctx: StageContext): Step {
  const st = backToSync(state);
  noteEvent(st, "merge deferred: behind; rebasing now", ctx.now());
  return doneStep({ ...state, st, resynced: true });
}

// This head passed every check, acceptance and the security review, so sync
// rebases it next sweep: on a conflict, or when it is behind again after this
// sweep's one rebase.
function deferred(state: StageState, ctx: StageContext, reason: string): Step {
  const st = backToSync(state);
  noteEvent(st, `merge deferred: ${reason}; will rebase next sweep`, ctx.now());
  return doneStep({ ...state, st });
}

function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = onlyReply(results);
  const { ok, error, merged, reason } = reply;
  if (ok !== true) {
    const why = "the merge step failed";
    const failed = { op: "merge", reason: why, error: textOrNull(error) };
    return opFailedStep(state, failed, ctx.now());
  }
  if (merged === true) {
    const st = { ...state.st, rebaseAllocated: 0, rechecking: false };
    return doneStep({ ...state, st, closed: true, outcome: "merged" });
  }
  if (reason === "queued") {
    return queued(state, ctx, reply);
  }
  if (reason === "behind" && !state.resynced) {
    return resyncNow(state, ctx);
  }
  if (reason === "behind" || reason === "conflict") {
    return deferred(state, ctx, reason);
  }
  return stopStep(state, "GitHub refused the merge", textOrNull(reason));
}

// The merge's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "decide":
      return decide(state, ctx, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
