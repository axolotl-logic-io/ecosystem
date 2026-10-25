// Authenticated durable intent and response checkpoints for landing recovery.
import { assignedBranch } from "../branch-binding.ts";
import type { Config } from "../config.ts";
import { FULL_SHA } from "../land-provenance.ts";
import { recordedAuthorization } from "../landed-authorization.ts";
import { OpsError } from "../ops-error.ts";
import { targetHolds } from "../reviewed-target.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import { candidateRefusal } from "../security-clearance.ts";
import type { IssueState, LandingAttempt, Revision } from "../state.ts";
import { approvalHolds, sameRevision } from "../state.ts";

// Confirm the intent checkpoint is actually readable before sending code.
function beginLand(
  cfg: Config,
  number: number,
  pr: number,
  { authorized, base }: { authorized: Revision; base: string },
): IssueState {
  const state = readWriteState(cfg, number);
  if (
    state.landingAttempt !== null ||
    state.codeLanded !== null ||
    (state.landed !== null && state.landed.code !== null) ||
    (state.security !== null && state.security.finding !== null) ||
    state.pr !== pr ||
    state.hardened === null ||
    !approvalHolds(state, authorized) ||
    candidateRefusal(state, authorized, cfg, base) !== undefined
  ) {
    throw new OpsError("merge has no fresh unattempted saved authorization");
  }
  const attempt: LandingAttempt = {
    repo: cfg.repo,
    pr: state.pr,
    target: cfg.baseBranch,
    branch: assignedBranch(cfg, number, state),
    authorized,
    hardened: state.hardened,
    integration: state.integration,
    operation: { kind: "fast-forward", base: FULL_SHA.parse(base) },
    result: null,
    reads: 0,
  };
  writeState(cfg, number, { ...state, landingAttempt: attempt });
  const saved = readWriteState(cfg, number);
  if (JSON.stringify(saved.landingAttempt) !== JSON.stringify(attempt)) {
    throw new OpsError(
      "merge attempt checkpoint is not confirmed; do not mutate the target",
    );
  }
  return saved;
}

function saveLandResponse(cfg: Config, number: number, result: string): void {
  FULL_SHA.parse(result);
  const state = readWriteState(cfg, number);
  if (state.landingAttempt === null || state.landingAttempt.result !== null) {
    throw new OpsError("successful response has no unique attempted merge");
  }
  const attempt = { ...state.landingAttempt, result };
  writeState(cfg, number, { ...state, landingAttempt: attempt });
  if (
    JSON.stringify(readWriteState(cfg, number).landingAttempt) !==
    JSON.stringify(attempt)
  ) {
    throw new OpsError("successful response checkpoint is not confirmed");
  }
}

function boundAttempt(
  cfg: Config,
  number: number,
  state: IssueState,
): LandingAttempt {
  const attempt = state.landingAttempt;
  if (
    attempt === null ||
    attempt.repo !== cfg.repo ||
    attempt.pr !== state.pr ||
    attempt.target !== cfg.baseBranch ||
    attempt.branch !== assignedBranch(cfg, number, state) ||
    attempt.authorized.code === null
  ) {
    throw new OpsError(
      "attempt identity or original hardening/integration authorization changed",
    );
  }
  return attempt;
}

function confirmAuthorization(
  state: IssueState,
  attempt: LandingAttempt,
): void {
  if (
    !sameRevision(
      recordedAuthorization(state) ?? { code: null, inputs: "" },
      attempt.authorized,
    ) ||
    state.hardened === null ||
    !sameRevision(state.hardened, attempt.hardened) ||
    JSON.stringify(state.integration) !== JSON.stringify(attempt.integration) ||
    (attempt.operation !== undefined &&
      !targetHolds(
        { repo: attempt.repo, baseBranch: attempt.target },
        state.hardenedTarget,
        attempt.operation.base,
      ))
  ) {
    throw new OpsError("original hardening/integration authorization changed");
  }
}

function saveReceipt(
  cfg: Config,
  number: number,
  state: IssueState,
  merged: Revision,
): void {
  writeState(cfg, number, { ...state, landed: merged });
  const saved = readWriteState(cfg, number);
  if (saved.landed === null || !sameRevision(saved.landed, merged)) {
    throw new OpsError("own-merge receipt save is not confirmed");
  }
}

export {
  beginLand,
  boundAttempt,
  confirmAuthorization,
  saveLandResponse,
  saveReceipt,
};
