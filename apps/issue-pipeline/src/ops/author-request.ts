// Explicit Author may revisit saved direct work without resetting its work or
// approvals. Its durable resumeStage is the interrupted checkpoint. Attempted,
// merged, completed or Security-rejected work must use its existing recovery.

import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { usedAuthor } from "../requirements.ts";
import { issuePullRequest } from "../revision.ts";
import type { Stage } from "../stages.ts";
import type { IssueState } from "../state.ts";
import { resumeOf, withLog } from "../state.ts";

function requestsAuthor(
  state: IssueState | null,
  stage?: Stage,
): state is IssueState {
  return stage === "author" && state !== null && !usedAuthor(state);
}

function returnStage(state: IssueState): "implement" | "review" | "merge" {
  const resumed = resumeOf(state);
  const { stage } = resumed;
  if (
    (stage !== "implement" && stage !== "review" && stage !== "merge") ||
    state.mergeAttempt !== null ||
    state.codeMerged !== null ||
    state.merged !== null ||
    (state.security !== null && state.security.finding !== null)
  ) {
    throw new OpsError(
      `#${state.number} cannot switch to Author: retain its completion, merge or Security recovery`,
    );
  }
  return stage;
}

// Preflight before a claim/label/checkout mutation, including live PR truth.
// The normal branch, trust, unanswered-input and competing-claim guards remain.
function assertAuthorRequest(
  cfg: Config,
  state: IssueState | null,
  stage?: Stage,
): void {
  if (!requestsAuthor(state, stage)) {
    return;
  }
  returnStage(state);
  const pr = issuePullRequest(cfg, state.number, state);
  if (pr !== null && pr.state !== "OPEN") {
    throw new OpsError(
      `#${state.number} cannot switch to Author: PR #${pr.number} is ${pr.state}`,
    );
  }
}

// Recheck reconciled state after winning the ordinary claim. A concurrent
// observed merge can refuse the transition, never erase that observation.
function requestedAuthorState(
  state: IssueState,
  request: { stage: "author" | "implement"; now: Date },
): IssueState {
  if (!requestsAuthor(state, request.stage)) {
    return state;
  }
  const checkpoint = returnStage(state);
  return withLog(
    {
      ...resumeOf(state),
      stage: "author",
      authorUsed: true,
      resumeStage: checkpoint,
    },
    `explicit Author requested at ${checkpoint}; retained work and authorization`,
    request.now,
  );
}

export { assertAuthorRequest, requestedAuthorState };
