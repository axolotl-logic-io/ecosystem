// The full diff the final reviewers read: prepared by ops for the issue's
// branch, and only good while the branch is still at the head that passed
// local verification.

import { textOrNull } from "./replies.ts";
import { onlyReply } from "./step.ts";
import type { LaunchResult, OpLaunch, StageState, StageStop } from "./types.ts";

// The prepared diff's path and length, or the stop when it can't be reviewed.
type FinalDiff =
  | { ok: true; path: string; lines: string }
  | { ok: false; stop: StageStop };

// The ops request that prepares the diff, its files tagged `tag`.
function finalDiffLaunch(state: StageState, tag: string): OpLaunch {
  return {
    kind: "op",
    name: "prep",
    op: "prepare-review",
    payload: { number: state.n, tag },
  };
}

// The diff from the reply to finalDiffLaunch. A failed request stops with
// `failure`; a branch that moved since verification stops too.
function finalDiffOf(
  state: StageState,
  results: readonly LaunchResult[],
  failure: string,
): FinalDiff {
  const { ok, error, headSha, diffPath, diffLines } = onlyReply(results);
  if (ok !== true) {
    return {
      ok: false,
      stop: { reason: failure, detail: textOrNull(error), code: null },
    };
  }
  if (headSha !== state.st.verifiedSha) {
    const reason = "the branch changed after verification";
    return { ok: false, stop: { reason, detail: null, code: null } };
  }
  return { ok: true, path: String(diffPath), lines: String(diffLines) };
}

export type { FinalDiff };
export { finalDiffLaunch, finalDiffOf };
