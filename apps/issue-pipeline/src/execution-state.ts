// Explicit-only authenticated state seam. Default jobs/ops do not import this
// module. This is not claim eligibility, job setup, teardown or release.
import { assignedBranch } from "./branch-binding.ts";
import { assertCommentAuthority } from "./comment-authority.ts";
import { isStateBody } from "./comment-marks.ts";
import type { IssueComment } from "./comments.ts";
import { listComments } from "./comments.ts";
import type { Config } from "./config.ts";
import {
  assertExecution,
  assertReconciled,
  confirmedWrite,
  issueExecution,
} from "./execution.ts";
import {
  assertExecutionHistory,
  currentExecutionReceipt,
} from "./execution-history.ts";
import { redactGhArgs } from "./github.ts";
import { assertFirstClaim } from "./ops/claim-state.ts";
import { withSavedCodeMerge } from "./ops/save-state.ts";
import { OpsError } from "./ops-error.ts";
import {
  latestStateComment,
  readClaimState,
  stateBody,
  writeState,
} from "./saved-state.ts";
import type { IssueState } from "./state.ts";
import { newIssueState, sameRevision } from "./state.ts";

function stateComments(cfg: Config, issue: number): IssueComment[] {
  const comments = listComments(cfg, issue);
  for (const comment of comments) {
    if (isStateBody(comment.body ?? "")) {
      assertCommentAuthority(cfg, comment);
    }
  }
  return comments;
}

// Read supported old state without changing it. Neither legacy compatibility
// nor a lapsed lane lease can initialize or acquire an existing issue.
function readExecutionClaimState(
  cfg: Config,
  issue: number,
): IssueState | null {
  assertReconciled(cfg, issue);
  issueExecution(cfg, issue); // Validate explicit full binding, even if absent.
  const comments = stateComments(cfg, issue);
  const saved = readClaimState(cfg, issue, comments);
  assignedBranch(cfg, issue, saved);
  if (saved === null) {
    assertFirstClaim(cfg, issue, comments);
  } else {
    assertExecutionHistory(cfg, issue, saved.execution);
  }
  return saved;
}

// One mutation attempt. The journal keeps the exact transmitted body and
// binding, not a local snapshot that could later confer writer permission.
function checkpoint(cfg: Config, issue: number, state: IssueState): IssueState {
  assertExecutionHistory(cfg, issue, state.execution, true);
  const [expected] = redactGhArgs([`body=${stateBody(issue, state)}`]);
  if (expected === undefined) {
    throw new OpsError("state body unavailable");
  }
  const before = latestStateComment(cfg, stateComments(cfg, issue));
  let comment: number | null = null;
  if (before !== undefined) {
    comment = before.id;
  }
  let confirmedState: IssueState | null = null;
  confirmedWrite(cfg, issue, "save-state", {
    evidence: {
      body: expected.slice("body=".length),
      issue,
      execution: state.execution ?? null,
      identity: cfg.execution ?? null,
      comment,
    },
    write: (): void => writeState(cfg, issue, state),
    confirmed: (): boolean => {
      const comments = stateComments(cfg, issue);
      const latest = latestStateComment(cfg, comments);
      if (
        latest === undefined ||
        (before !== undefined && latest.id !== before.id) ||
        `body=${latest.body}` !== expected
      ) {
        return false;
      }
      confirmedState = readClaimState(cfg, issue, comments);
      return confirmedState !== null;
    },
  });
  assertExecution(cfg, issue);
  if (confirmedState === null) {
    throw new OpsError("saved state not confirmed; reconciliation required");
  }
  return confirmedState;
}

// Bind the strictly inspected state to a newly confirmed owner, preserving
// stage and all saved work. Callers may set up only after this checkpoint.
// Broad claim transitions and eligibility remain outside this preparatory API.
function claimExecutionState(cfg: Config, issue: number): IssueState {
  const saved = readExecutionClaimState(cfg, issue);
  const guard = issueExecution(cfg, issue);
  guard.request();
  if (!guard.acquire()) {
    throw new OpsError(
      "execution ownership unavailable; reconciliation required",
    );
  }
  const state = saved ?? newIssueState(issue);
  return checkpoint(cfg, issue, {
    ...state,
    branch: assignedBranch(cfg, issue, saved),
    execution: currentExecutionReceipt(cfg, issue),
  });
}

function retainedMergeAuthorization(
  saved: IssueState,
  state: IssueState,
): Partial<IssueState> {
  // Observing an external merge must not freeze fresh postmerge hardening.
  // Stale snapshots still cannot erase historical recovery authorization.
  if (
    saved.mergeAttempt === null &&
    (saved.codeMerged === null || state.hardened !== null)
  ) {
    return {};
  }
  return {
    hardened: saved.hardened,
    hardenedTarget: saved.hardenedTarget,
    integration: saved.integration,
  };
}

function retainedMergedTruth(
  saved: IssueState,
  state: IssueState,
): IssueState["merged"] {
  // An own-merge receipt binds inputs, policy and legacy wiki as well as code.
  // A same-SHA role snapshot must not rewrite that exact recovery authority.
  if (
    saved.merged !== null &&
    (saved.mergeAttempt !== null ||
      state.merged === null ||
      state.hardened === null ||
      !sameRevision(state.hardened, state.merged))
  ) {
    return saved.merged;
  }
  const merged = state.merged ?? saved.merged;
  const observed = saved.codeMerged?.sha ?? saved.merged?.code;
  if (
    observed !== undefined &&
    observed !== null &&
    merged?.code !== observed
  ) {
    return saved.merged;
  }
  return merged;
}

function saveExecutionState(
  cfg: Config,
  issue: number,
  state: IssueState,
): IssueState {
  assertExecution(cfg, issue);
  const saved = readClaimState(cfg, issue, stateComments(cfg, issue));
  if (saved === null) {
    throw new OpsError(
      "saved execution authority missing; reconciliation required",
    );
  }
  assertExecutionHistory(cfg, issue, saved.execution, true);
  if (state.execution !== undefined) {
    assertExecutionHistory(cfg, issue, state.execution, true);
  }
  assignedBranch(cfg, issue, saved);
  assignedBranch(cfg, issue, state);
  const retained = withSavedCodeMerge(
    cfg,
    issue,
    {
      ...state,
      branch: saved.branch,
      // A stale/null snapshot cannot erase durable work. Explicit head updates
      // remain allowed, as in the existing push/adopt/sync save paths.
      headSha: state.headSha ?? saved.headSha,
      pr: saved.pr ?? state.pr,
      merged: retainedMergedTruth(saved, state),
      ...retainedMergeAuthorization(saved, state),
      execution: saved.execution,
    },
    saved,
  );
  return checkpoint(cfg, issue, retained);
}

export { claimExecutionState, readExecutionClaimState, saveExecutionState };
