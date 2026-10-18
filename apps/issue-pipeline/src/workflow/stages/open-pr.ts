// Open-pr: marks the issue's PR ready for review, with the title and body the
// implementer wrote, and moves the issue to review. A change that lives only
// in the wiki closes the draft instead; one that changed nothing stops
// (flow-step.ts).

import { noteEvent } from "../event-log.ts";
import { flowStep, prFlowed } from "./flow-step.ts";
import { doneStep, launchStep, onlyReply, stopStep } from "./step.ts";
import type { LaunchResult, StageContext, StageState, Step } from "./types.ts";

// Where open-pr is: about to ask for the PR, reading the reply, or reading
// close-pr's reply.
type OpenPrPhase = "begin" | "opened" | "flowed";

const PHASES: readonly OpenPrPhase[] = ["begin", "opened", "flowed"];

function phaseOf(state: StageState): OpenPrPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`open-pr: unknown phase ${state.phase}`);
  }
  return phase;
}

// Asks for the PR, reopening the one a wiki-only change closed (#418).
function begin(state: StageState): Step {
  const { prTitle, prBody, prBy, prClosed, pr } = state.st;
  let reopen = {};
  if (prClosed === true) {
    reopen = { reopen: pr };
  }
  const payload = { number: state.n, title: prTitle, body: prBody, by: prBy };
  return launchStep({ ...state, phase: "opened" }, [
    {
      kind: "op",
      name: "openpr",
      op: "open-pr",
      payload: { ...payload, ...reopen },
    },
  ]);
}

function errorOf(error: unknown): string | null {
  if (typeof error !== "string") {
    return null;
  }
  return error;
}

// Moves the issue to review.
function toReview(state: StageState, ctx: StageContext): Step {
  const st = { ...state.st, stage: "review" };
  let note = `PR #${String(st.pr)} is ready for review`;
  if (st.prClosed === true) {
    note = `the change lives only in the wiki; closed PR #${String(st.pr)}`;
  }
  noteEvent(st, note, ctx.now());
  return doneStep({ ...state, st });
}

// Records the PR and acts on the flows, or stops.
function opened(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = onlyReply(results);
  const { ok, error, pr, headSha } = reply;
  if (ok !== true || typeof pr !== "number" || typeof headSha !== "string") {
    return stopStep(state, "could not open the PR", errorOf(error));
  }
  const st = { ...state.st, pr, headSha, implemented: true };
  if (st.prClosed === true) {
    // begin reopened it.
    st.prClosed = false;
  }
  return flowStep({ ...state, st }, ctx, reply, {
    phase: "flowed",
    goOn: toReview,
  });
}

// Open-pr's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state);
    case "opened":
      return opened(state, ctx, results);
    case "flowed":
      return prFlowed(state, ctx, results, toReview);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
