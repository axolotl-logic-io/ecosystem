// The job's state writes: save-state writes a role's state and nothing else;
// release writes the state the job ends with, renewing its lease, and keeps
// the lane's claim live. Neither can clear attempted/observed merge evidence
// recorded by the claim or merge reconciliation. Stale role snapshots must
// not erase a response or confirmed receipt saved inside the merge op. The
// comments the job queued ride along on every op (see ops.ts).

import { z } from "zod";
import { touchClaim } from "../claims.ts";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import { sameSecuritySubject } from "../security-clearance.ts";
import type { IssueState, Security } from "../state.ts";
import { ISSUE_STATE, sameRevision } from "../state.ts";
import { retainedFastForwardReceipt } from "./fast-forward-evidence.ts";

const SAVE_REQUEST = z.looseObject({
  number: z.number().int().positive(),
  state: ISSUE_STATE,
});

const RELEASE_REQUEST = z.looseObject({
  lane: z.string().min(1),
  number: z.number().int().positive(),
  state: ISSUE_STATE,
  sweepId: z.string().min(1),
});

type EmptyReply = Record<string, never>;

// Keep an exact durable decision across a stale save, but let fresh inputs or
// target provenance replace obsolete clearance. A rejection of the same
// code/inputs cannot be rerolled merely by changing the target.
function sameCandidateDecision(
  saved: Security,
  requested: Security | null,
  headSha: string | null,
): boolean {
  if (saved.phase !== "candidate" || saved.revision.code !== headSha) {
    return false;
  }
  if (requested === null) {
    return true;
  }
  if (!sameRevision(saved.revision, requested.revision)) {
    return false;
  }
  return (
    requested.phase === undefined ||
    (saved.target.repo === requested.target.repo &&
      saved.target.branch === requested.target.branch &&
      saved.target.sha === requested.target.sha)
  );
}

function retainedResultSecurity(
  saved: IssueState,
  state: IssueState,
): Partial<Pick<IssueState, "resultSecurity">> {
  let { resultSecurity } = state;
  const observed = saved.resultSecurity;
  if (
    observed !== undefined &&
    observed !== null &&
    (resultSecurity === undefined ||
      resultSecurity === null ||
      (observed.finding !== null &&
        sameSecuritySubject(observed.revision, resultSecurity.revision)) ||
      (sameRevision(observed.revision, resultSecurity.revision) &&
        JSON.stringify(observed.target) ===
          JSON.stringify(resultSecurity.target)))
  ) {
    resultSecurity = observed;
  }
  if (resultSecurity === undefined) {
    return {};
  }
  return { resultSecurity };
}

// `state` as issue `n` may save it: for issue `n`, with the saved code merge.
function withSavedCodeMerge(
  cfg: Config,
  n: number,
  state: IssueState,
  saved: IssueState,
): IssueState {
  if (state.number !== n) {
    throw new OpsError(`a state for #${state.number} can't be saved on #${n}`);
  }
  let { merged } = state;
  if (
    saved.mergeAttempt !== null &&
    saved.merged !== null &&
    (retainedFastForwardReceipt(cfg, n, saved) ||
      (saved.mergeAttempt.operation === undefined &&
        saved.merged.code === saved.mergeAttempt.result)) &&
    state.merged?.code !== saved.merged.code
  ) {
    ({ merged } = saved);
  }
  // An exact durable decision survives an interrupted save's stale snapshot,
  // whether it rejected the result or already cleared it for completion.
  let { security } = state;
  if (
    saved.security !== null &&
    ((saved.security.finding !== null &&
      (security === null ||
        sameSecuritySubject(saved.security.revision, security.revision))) ||
      (merged !== null && sameRevision(saved.security.revision, merged)) ||
      sameCandidateDecision(saved.security, security, state.headSha))
  ) {
    ({ security } = saved);
  }
  return {
    ...state,
    security,
    ...retainedResultSecurity(saved, state),
    merged,
    codeMerged: saved.codeMerged,
    mergeAttempt: saved.mergeAttempt,
  };
}

// Writes issue `n`'s state, with the code merge it has saved.
function saveIssueState(cfg: Config, n: number, state: IssueState): IssueState {
  const written = withSavedCodeMerge(cfg, n, state, readWriteState(cfg, n));
  writeState(cfg, n, written);
  return written;
}

function saveState(cfg: Config, request: unknown): EmptyReply {
  const { number, state } = parseRequest(SAVE_REQUEST, "save-state", request);
  saveIssueState(cfg, number, state);
  return {};
}

// The job ends with the issue unfinished. Its lane keeps the lease and its
// claim, renewed, and its next job continues the issue. If the lane never
// comes back, the lease and claim expire after leaseHours and another lane
// may take it.
function release(cfg: Config, request: unknown): EmptyReply {
  const req = parseRequest(RELEASE_REQUEST, "release", request);
  const { lease } = req.state;
  let renewed: IssueState["lease"] = null;
  if (lease !== null) {
    renewed = { ...lease, at: new Date().toISOString() };
  }
  saveIssueState(cfg, req.number, { ...req.state, lease: renewed });
  touchClaim(cfg, req.number, req);
  return {};
}

export { release, saveIssueState, saveState, withSavedCodeMerge };
