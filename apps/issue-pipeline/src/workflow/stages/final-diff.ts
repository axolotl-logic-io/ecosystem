// The full diff the final reviewers read: prepared by ops for the issue's
// branch, and only good while the branch is still at the head that passed
// local verification.

import { opFailedStep } from "./network.ts";
import { textOrNull } from "./replies.ts";
import { prepareLaunch } from "./stacked.ts";
import { onlyReply, stopStep } from "./step.ts";
import type {
  LaunchResult,
  OpLaunch,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// The prepared diff's path and length, or the step to return when it can't
// be reviewed: a stop, or a deferral to the next sweep.
type FinalDiff =
  | { ok: true; path: string; lines: string }
  | { ok: false; step: Step };

// The ops request that prepares the diff, its files tagged `tag`.
function finalDiffLaunch(state: StageState, tag: string): OpLaunch {
  return prepareLaunch(state, { tag });
}

// The diff from the reply to finalDiffLaunch. A request that failed on the
// network defers to the next sweep; one that failed otherwise stops with
// `failure`; a branch that moved since verification stops too.
function finalDiffOf(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
  failure: string,
): FinalDiff {
  const { ok, error, headSha, diffPath, diffLines } = onlyReply(results);
  if (ok !== true) {
    const failed = {
      op: "prepare-review",
      reason: failure,
      error: textOrNull(error),
    };
    return { ok: false, step: opFailedStep(state, failed, ctx.now()) };
  }
  if (headSha !== state.st.verifiedSha) {
    const reason = "the branch changed after verification";
    return { ok: false, step: stopStep(state, reason, null) };
  }
  return { ok: true, path: String(diffPath), lines: String(diffLines) };
}

export type { FinalDiff };
export { finalDiffLaunch, finalDiffOf };
