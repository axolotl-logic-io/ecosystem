// The continuations of the writer stages (#269): a writer session that runs
// out of room hands off, and a new session of the same stage continues from
// its handoff. Each stage may continue up to config `maxContinuations` times
// per issue; past that the issue stops as too large. This module alone knows
// how the state keeps the counts, including the older form, a single number
// that counted the implementer's continuations.

import type { Continuations, IssueState } from "../types.ts";

// The writer stages that hand off.
type ContinuationStage = "implement" | "fix" | "ciFix" | "conflicts";

type ContinuationState = Pick<IssueState, "continuations">;

interface ContinuationConfig {
  maxContinuations: number;
}

function countsOf(st: ContinuationState): Continuations {
  const { continuations } = st;
  if (continuations === undefined) {
    return {};
  }
  if (typeof continuations === "number") {
    return { implement: continuations };
  }
  return continuations;
}

// How many continuations `stage` has had for the issue.
function continuationsOf(
  st: ContinuationState,
  stage: ContinuationStage,
): number {
  const { [stage]: count = 0 } = countsOf(st);
  return count;
}

// `st` with one more continuation of `stage` counted.
function continued<State extends ContinuationState>(
  st: State,
  stage: ContinuationStage,
): State {
  const counts = { ...countsOf(st), [stage]: continuationsOf(st, stage) + 1 };
  return { ...st, continuations: counts };
}

// Whether `stage` may continue from another handoff.
function mayContinue(
  st: ContinuationState,
  cfg: ContinuationConfig,
  stage: ContinuationStage,
): boolean {
  return continuationsOf(st, stage) < cfg.maxContinuations;
}

// The stop reason for a writer `role` that handed off with no continuation
// left, when `max` were allowed.
function outOfRoomReason(role: string, max: number): string {
  return `the ${role} ran out of room in its session and its ${max} continuation(s) (maxContinuations); the issue needs splitting`;
}

export type { ContinuationStage };
export { continuationsOf, continued, mayContinue, outOfRoomReason };
