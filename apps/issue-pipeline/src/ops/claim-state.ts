// The state a claim carries on from: the saved one (a new issue's first, a
// stopped one's with its stop lifted), with the pipeline's own unsaved push
// adopted (adopt-push.ts) and then its code merge reconciled against GitHub
// (revision.ts). The branch-changed defense is the caller's: this module
// only reports a branch head that moved past the saved one without the
// pipeline, as a diagnostic.

import { adoptPush } from "../adopt-push.ts";
import { assignedBranch } from "../branch-binding.ts";
import { lastPush } from "../checkouts.ts";
import type { IssueComment } from "../comments.ts";
import type { Config } from "../config.ts";
import { remoteHead } from "../git-state.ts";
import { OpsError } from "../process.ts";
import { codeMergedOf, issuePullRequest } from "../revision.ts";
import { readClaimState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { newIssueState, resumeOf, withLog } from "../state.ts";

// A branch head on GitHub that is neither the saved one nor the pipeline's
// own push.
interface BranchChanged {
  saved: string;
  remote: string;
}

interface ClaimedState {
  state: IssueState;
  remote: string | null;
  // Whether a push of the pipeline's own was adopted.
  adopted: boolean;
  branchChanged: BranchChanged | null;
}

// The saved state the claim starts from. A done issue is claimed only to
// reconcile its completion: it must have saved what merged.
function startingState(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
): IssueState {
  const saved = readClaimState(cfg, n, comments);
  if (saved === null) {
    return { ...newIssueState(n), branch: assignedBranch(cfg, n, null) };
  }
  if (saved.stage === "done" && saved.merged === null) {
    throw new OpsError(`#${n} is done`);
  }
  return { ...resumeOf(saved), branch: assignedBranch(cfg, n, saved) };
}

// Throws, before a claim writes anything, when the issue's saved state is
// bound to another branch than the one assigned (branch-binding.ts).
function assertBranchAssigned(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
): void {
  assignedBranch(cfg, n, readClaimState(cfg, n, comments));
}

// `state` with its PR and code merge as GitHub reports them. A recorded
// code merge GitHub doesn't confirm, or a completion GitHub reports another
// code merge for (none, for a change that lives only in the wiki), throws:
// the claim never clears or replaces a merge it recorded.
function reconciled(
  cfg: Config,
  n: number,
  state: IssueState,
  now: Date,
): IssueState {
  const pr = issuePullRequest(cfg, n, state);
  const codeMerged = codeMergedOf(pr);
  const recorded = state.codeMerged ?? null;
  if (
    recorded !== null &&
    (codeMerged === null ||
      codeMerged.pr !== recorded.pr ||
      codeMerged.sha !== recorded.sha)
  ) {
    throw new OpsError(
      `GitHub doesn't confirm #${n}'s recorded code merge (PR #${recorded.pr} at ${recorded.sha})`,
    );
  }
  if (
    state.stage === "done" &&
    state.merged?.code !== (codeMerged?.sha ?? null)
  ) {
    throw new OpsError(
      `#${n} is done, but GitHub doesn't confirm the merge it saved`,
    );
  }
  const next: IssueState = { ...state, pr: pr?.number ?? null, codeMerged };
  if (recorded === null && codeMerged !== null) {
    return withLog(
      next,
      `GitHub reports PR #${codeMerged.pr} merged as ${codeMerged.sha}`,
      now,
    );
  }
  return next;
}

// The branch head GitHub has that the saved state doesn't, unless the code
// merged, which leaves the branch head no longer the code's revision.
function branchChangedOf(
  state: IssueState,
  remote: string | null,
): BranchChanged | null {
  const { headSha, codeMerged } = state;
  if (codeMerged !== null || headSha === null || remote === null) {
    return null;
  }
  if (remote === headSha) {
    return null;
  }
  return { saved: headSha, remote };
}

function claimedState(
  cfg: Config,
  n: number,
  comments: readonly IssueComment[],
  now: Date,
): ClaimedState {
  const start = startingState(cfg, n, comments);
  const remote = remoteHead(cfg, n);
  const adoptedState = adoptPush(start, remote, lastPush(cfg, n), now);
  const state = reconciled(cfg, n, adoptedState ?? start, now);
  return {
    state,
    remote,
    adopted: adoptedState !== null,
    branchChanged: branchChangedOf(state, remote),
  };
}

export type { BranchChanged, ClaimedState };
export { assertBranchAssigned, claimedState };
