// The job's state writes: save-state writes a role's state and nothing else;
// release writes the state the job ends with, renewing its lease, and keeps
// the lane's claim live. Neither can set or clear saved merge/adoption
// reconciliation; only validated GitHub operations establish it. The
// comments the job queued ride along on every op (see ops.ts).

import { z } from "zod";
import { touchClaim } from "../claims.ts";
import type { Config } from "../config.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { readWriteState, writeState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import { ISSUE_STATE } from "../state.ts";

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

// A role state can neither fabricate nor erase saved merge/adoption evidence.
function withSavedReconciliation(
  cfg: Config,
  n: number,
  state: IssueState,
): IssueState {
  if (state.number !== n) {
    throw new OpsError(`a state for #${state.number} can't be saved on #${n}`);
  }
  const saved = readWriteState(cfg, n);
  return { ...state, codeMerged: saved.codeMerged, adoption: saved.adoption };
}

// Writes role state while retaining independently saved reconciliation.
function saveIssueState(cfg: Config, n: number, state: IssueState): IssueState {
  const written = withSavedReconciliation(cfg, n, state);
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

export { release, saveIssueState, saveState };
