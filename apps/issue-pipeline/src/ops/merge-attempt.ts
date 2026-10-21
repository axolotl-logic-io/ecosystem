// Authenticated durable intent and response checkpoints for merge recovery.
import { assignedBranch } from "../branch-binding.ts";
import type { Config } from "../config.ts";
import { FULL_SHA } from "../merge-provenance.ts";
import { OpsError } from "../ops-error.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import type { IssueState, MergeAttempt, Revision } from "../state.ts";
import { approvalHolds, sameRevision } from "../state.ts";

// Confirm the pre-POST checkpoint is actually readable before sending code.
function beginMerge(
  cfg: Config,
  number: number,
  pr: number,
  { authorized, base }: { authorized: Revision; base: string },
): IssueState {
  const state = readWriteState(cfg, number);
  if (
    state.mergeAttempt !== null ||
    state.codeMerged !== null ||
    (state.merged !== null && state.merged.code !== null) ||
    (state.security !== null && state.security.finding !== null) ||
    state.pr !== pr ||
    state.hardened === null ||
    !approvalHolds(state, authorized)
  ) {
    throw new OpsError("merge has no fresh unattempted saved authorization");
  }
  const attempt: MergeAttempt = {
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
  writeState(cfg, number, { ...state, mergeAttempt: attempt });
  const saved = readWriteState(cfg, number);
  if (JSON.stringify(saved.mergeAttempt) !== JSON.stringify(attempt)) {
    throw new OpsError(
      "merge attempt checkpoint is not confirmed; do not send a merge POST",
    );
  }
  return saved;
}

function saveMergeResponse(cfg: Config, number: number, result: string): void {
  FULL_SHA.parse(result);
  const state = readWriteState(cfg, number);
  if (state.mergeAttempt === null || state.mergeAttempt.result !== null) {
    throw new OpsError("successful response has no unique attempted merge");
  }
  const attempt = { ...state.mergeAttempt, result };
  writeState(cfg, number, { ...state, mergeAttempt: attempt });
  if (
    JSON.stringify(readWriteState(cfg, number).mergeAttempt) !==
    JSON.stringify(attempt)
  ) {
    throw new OpsError("successful response checkpoint is not confirmed");
  }
}

function boundAttempt(
  cfg: Config,
  number: number,
  state: IssueState,
): MergeAttempt {
  const attempt = state.mergeAttempt;
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

function confirmAuthorization(state: IssueState, attempt: MergeAttempt): void {
  if (
    !approvalHolds(state, attempt.authorized) ||
    state.hardened === null ||
    !sameRevision(state.hardened, attempt.hardened) ||
    JSON.stringify(state.integration) !== JSON.stringify(attempt.integration)
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
  writeState(cfg, number, { ...state, merged });
  const saved = readWriteState(cfg, number);
  if (saved.merged === null || !sameRevision(saved.merged, merged)) {
    throw new OpsError("own-merge receipt save is not confirmed");
  }
}

export {
  beginMerge,
  boundAttempt,
  confirmAuthorization,
  saveMergeResponse,
  saveReceipt,
};
