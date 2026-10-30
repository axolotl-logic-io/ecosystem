// What Verify makes of the required CI on the one PR head it reviews. It
// rereads the PR until its required checks have a verdict on that head:
// clear when every one passed or was skipped, failing when any failed or
// was cancelled. Checks still running, or none reported yet on a head
// whose repository requires CI, are no verdict, so it waits and reads
// again, up to its limit. A head that moved, a PR that's gone and a wait
// past the limit end the wait with an error, since Verify can then judge
// nothing.

import type { PullRequest } from "@ecosystem/task-runtime/issue/recovery";
import { OpsError } from "@ecosystem/task-runtime/ops-error";

const MS_PER_SECOND = 1000;
const FAILING: ReadonlySet<string> = new Set(["fail", "cancel"]);

// The verdict, and the PR as the read that found it saw it.
type CiVerdict = (
  | { state: "clear" }
  | { state: "failing"; failing: string[] }
) & { pull: PullRequest };

interface CiWait {
  // The head under review.
  head: string;
  // The issue's PR as GitHub reports it now, or null when it has none.
  read: () => PullRequest | null;
  // Whether no required check at all is no verdict yet.
  requireCi: boolean;
  // The pause between reads, and how long the reads may wait in all.
  pauseMs: number;
  limitMs: number;
  sleep: (ms: number) => Promise<void>;
  // Throws when the run must end before its next read.
  checkStop: () => void;
}

// Waits for the required CI's verdict on `wait.head`, having waited
// `waited` ms so far.
async function requiredCi(wait: CiWait, waited = 0): Promise<CiVerdict> {
  const { head } = wait;
  const pull = wait.read();
  if (pull === null) {
    throw new OpsError("the issue's PR is gone while Verify waited for CI");
  }
  if (pull.headSha !== head) {
    throw new OpsError(
      `PR #${pull.number}'s head moved from ${head} to ${pull.headSha} while Verify waited for its CI`,
    );
  }
  const failing = pull.checks
    .filter((check) => FAILING.has(check.bucket))
    .map((check) => check.name);
  if (failing.length > 0) {
    return { state: "failing", failing, pull };
  }
  const running =
    pull.checks.some((check) => check.bucket === "pending") ||
    (pull.checks.length === 0 && wait.requireCi);
  if (!running) {
    return { state: "clear", pull };
  }
  if (waited >= wait.limitMs) {
    throw new OpsError(
      `required CI on ${head} had no verdict after ${Math.round(waited / MS_PER_SECOND)} seconds`,
    );
  }
  await wait.sleep(wait.pauseMs);
  wait.checkStop();
  return requiredCi(wait, waited + wait.pauseMs);
}

export type { CiVerdict, CiWait };
export { requiredCi };
