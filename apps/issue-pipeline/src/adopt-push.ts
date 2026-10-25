// The adoption of a push whose state save failed: a claim that finds the
// branch at a head this machine recorded the pipeline pushing, past the saved
// one, carries on from it instead of reporting the branch changed, and never
// passes it without the review that follows any code change.
import type { PushRecord } from "./checkouts.ts";
import type { IssueState } from "./state.ts";
import { withLog } from "./state.ts";

// How much of a head the log names.
const LOG_SHA_LENGTH = 8;

// The saved state with the pipeline's own push of `remote` adopted, for when
// the push landed after the last state save: the saved head is set, and
// `remote` differs from it but is the head this machine last recorded
// pushing (`pushed`). The head and verification move to `remote` and the
// last verdict is voided (its revision stays for diagnostics); a review or a
// Land goes back to review, so no code change skips one. A stopped or done
// issue, or one whose code has landed, adopts nothing. Null when there is
// nothing to adopt.
function adoptPush(
  saved: IssueState,
  remote: string | null,
  pushed: PushRecord | null,
  now: Date,
): IssueState | null {
  const { headSha, stage } = saved;
  if (headSha === null || remote === null || remote === headSha) {
    return null;
  }
  if (pushed === null || remote !== pushed.sha) {
    return null;
  }
  if (
    stage === "stopped" ||
    stage === "done" ||
    saved.codeMerged !== null ||
    saved.mergeAttempt !== null
  ) {
    return null;
  }
  let next = stage;
  if (stage === "review" || stage === "merge") {
    next = "review";
  }
  const adopted: IssueState = {
    ...saved,
    stage: next,
    headSha: remote,
    verifiedSha: null,
    review: { ...saved.review, verdict: null },
  };
  return withLog(
    adopted,
    `adopted the pipeline's own ${pushed.op} push ${remote.slice(0, LOG_SHA_LENGTH)} at ${stage}; its state save had failed`,
    now,
  );
}

export { adoptPush };
