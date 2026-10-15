// Open-pr: marks the issue's PR ready for review, with the title and body the
// implementer wrote, and moves the issue to review.

import { noteEvent } from "../event-log.ts";
import { doneStep, launchStep, onlyReply, stopStep } from "./step.ts";
import type { LaunchResult, StageContext, StageState, Step } from "./types.ts";

// Where open-pr is: about to ask for the PR, or reading the reply.
type OpenPrPhase = "begin" | "opened";

const PHASES: readonly OpenPrPhase[] = ["begin", "opened"];

function phaseOf(state: StageState): OpenPrPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`open-pr: unknown phase ${state.phase}`);
  }
  return phase;
}

function begin(state: StageState): Step {
  const { prTitle, prBody, prBy } = state.st;
  const payload = { number: state.n, title: prTitle, body: prBody, by: prBy };
  return launchStep({ ...state, phase: "opened" }, [
    { kind: "op", name: "openpr", op: "open-pr", payload },
  ]);
}

function errorOf(error: unknown): string | null {
  if (typeof error !== "string") {
    return null;
  }
  return error;
}

// Records the PR and moves the issue to review, or stops.
function opened(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const { ok, error, pr, headSha } = onlyReply(results);
  if (ok !== true || typeof pr !== "number" || typeof headSha !== "string") {
    return stopStep(state, "could not open the PR", errorOf(error));
  }
  const st = {
    ...state.st,
    pr,
    headSha,
    implemented: true,
    stage: "review",
  };
  noteEvent(st, `PR #${pr} is ready for review`, ctx.now());
  return doneStep({ ...state, st });
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
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
