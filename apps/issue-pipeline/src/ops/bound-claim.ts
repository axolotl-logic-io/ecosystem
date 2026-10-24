// The claim of a stage job bound to its invocation (#167): ops.ts runs it
// for every claim that carries an execution binding. Lane resources are
// readiness evidence, never execution authority.
import { ensureClone, setUpCheckout } from "../checkouts.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { assertExecution, issueExecution } from "../execution.ts";
import {
  claimExecutionState,
  readExecutionClaimState,
  saveExecutionClaimState,
} from "../execution-state.ts";
import { gh, issueState } from "../github.ts";
import type { IssueContext } from "../issue-context.ts";
import { trustedInputsHash, writeIssueContext } from "../issue-context.ts";
import {
  assertCheckoutReady,
  pruneLaneResources,
  withCheckoutSlot,
} from "../lane-slots.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import type { IssueState } from "../state.ts";
import { resumeOf, withLog } from "../state.ts";
import { assertStopRecoveryResolved } from "../stop-recovery.ts";
import { assertAuthorRequest } from "./author-request.ts";
import type { ClaimRequest, ClaimWon } from "./claim.ts";
import {
  CLAIM_REQUEST,
  CLAIMED_ISSUE,
  hasWorktree,
  labelWorking,
  readyCheckouts,
} from "./claim.ts";
import { assertClosedMergeRecovery, claimedState } from "./claim-state.ts";

function boundClaim(
  cfg: Config,
  request: unknown,
): ClaimWon | { waiting: "answer" } {
  const req = parseRequest(CLAIM_REQUEST, "bound claim", request);
  const n = req.number;
  // Validate full binding before reading inputs or touching checkout resources.
  issueExecution(cfg, n);
  if (cfg.execution?.lane !== req.lane) {
    throw new OpsError("claim lane differs from execution binding");
  }
  assertStopRecoveryResolved(cfg, n);
  const saved = readExecutionClaimState(cfg, n);
  if (saved?.execution?.instance === cfg.execution?.instance) {
    throw new OpsError(
      "claim requires fresh execution ownership after release",
    );
  }
  const context = writeIssueContext(cfg, n);
  const issue = CLAIMED_ISSUE.parse(context.issue);
  const recovering = issue.state === "closed";
  if (recovering) {
    assertClosedMergeRecovery(cfg, n, saved);
  } else if (issue.state !== "open") {
    throw new OpsError(`#${n} is not open`);
  }
  if (
    saved?.asked?.inputs ===
    trustedInputsHash(cfg, context.issue, context.comments)
  ) {
    return { waiting: "answer" };
  }
  assertAuthorRequest(cfg, saved, req.stage);
  const wt = paths.worktree(cfg, n);
  // A stage job's own checkout is always new (job/checkout.ts refuses an
  // existing one), so only a retained issue worktree must prove readiness.
  const existed = hasWorktree(cfg, n) && cfg.checkout?.issue !== n;
  if (existed) {
    assertCheckoutReady(cfg, n, wt);
  }
  let stage: "author" | "implement" = "implement";
  if (req.stage === "author") {
    stage = "author";
  }
  const result = withCheckoutSlot(
    cfg,
    n,
    (): ClaimWon =>
      prepareBoundClaim(cfg, req, context, { recovering, existed, stage }),
  );
  if (result === null) {
    throw new OpsError("claim reservation unavailable");
  }
  return result;
}

interface Preparation {
  recovering: boolean;
  existed: boolean;
  stage: "author" | "implement";
}
function prepareBoundClaim(
  cfg: Config,
  req: ClaimRequest,
  context: IssueContext,
  preparation: Preparation,
): ClaimWon {
  const n = req.number;
  const wt = paths.worktree(cfg, n);
  const { recovering, existed, stage } = preparation;
  // Child 1 owns request/confirmation, immutable epoch and exact save readback.
  // In particular, old lease age and lane identity cannot bypass its checks.
  const owned = claimExecutionState(cfg, n, stage);
  assertExecution(cfg, n);
  if (
    owned.asked?.inputs ===
    trustedInputsHash(cfg, context.issue, context.comments)
  ) {
    throw new OpsError("claim eligibility changed; reconciliation required");
  }
  if (recovering) {
    assertClosedMergeRecovery(cfg, n, owned);
  }
  ensureClone(cfg);
  const now = new Date();
  const claimed = claimedState(cfg, n, resumeOf(owned), {
    now,
    stage,
  });
  if (recovering) {
    // Eligibility was proved before reopen; this grants no writer authority.
    gh(cfg, "merge", ["issue", "reopen", String(n), "-R", cfg.repo]);
    if (issueState(cfg, n) !== "open") {
      throw new OpsError(`could not confirm #${n} reopened for Merge recovery`);
    }
  }
  if (owned.execution === undefined) {
    throw new OpsError("confirmed execution receipt missing");
  }
  const claimId = owned.execution.request;
  let state: IssueState = {
    ...claimed.state,
    execution: owned.execution,
    lease: { lane: req.lane, sweepId: req.sweepId, at: now.toISOString() },
  };
  if (state.stage !== "done") {
    const entry = readyCheckouts(cfg, n, claimed, now);
    if (entry !== null) {
      state = withLog(state, entry, now);
    }
  }
  // Save before setup, including lane failure: retained slots are not receipts.
  state = saveExecutionClaimState(cfg, n, state, now);
  if (state.stage !== "done") {
    labelWorking(cfg, n, CLAIMED_ISSUE.parse(context.issue).labels, state.pr);
    if (!existed || cfg.laneSlots !== undefined) {
      setUpCheckout(cfg, n, wt, "setup-at-claim.log");
    }
    pruneLaneResources(cfg);
  }
  assertExecution(cfg, n);
  return claimResult(cfg, context, { claimed, state, claimId });
}
function claimResult(
  cfg: Config,
  context: IssueContext,
  result: {
    claimed: ReturnType<typeof claimedState>;
    state: IssueState;
    claimId: number;
  },
): ClaimWon {
  const { claimed, state, claimId } = result;
  const n = state.number;
  const won: ClaimWon = {
    state,
    claim: { id: claimId, posted: true },
    remoteHead: claimed.remote,
    issueFile: context.file,
    issue: context.issue,
    comments: context.comments,
    paths: {
      worktree: paths.worktree(cfg, n),
      runDir: paths.runDir(cfg, n),
      issueFile: context.file,
    },
  };
  if (claimed.branchChanged !== null) {
    won.branchChanged = claimed.branchChanged;
  }
  return won;
}

export { boundClaim };
