// ready-pr: the only op that marks an issue's draft PR ready for review,
// once the Reviewer's hardening authorized its exact revision and that
// authorization is saved. open-pr
// and merge never mark a PR ready.

import { z } from "zod";
import { assignedBranch } from "../branch-binding.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { assertPrBase } from "../pr-authority.ts";
import { parseRequest } from "../process.ts";
import { currentRevision } from "../revision.ts";
import { readState } from "../saved-state.ts";
import type { IssueState } from "../state.ts";
import {
  approvalHolds,
  ISSUE_STATE,
  mergeAuthorization,
  sameRevision,
} from "../state.ts";

interface ReadyReply {
  pr: number;
  ready: true;
}

const READY_REQUEST = z.looseObject({
  number: z.number().int(),
  state: ISSUE_STATE,
});
// GitHub's answer to the PR view ready-pr decides on.
const READY_VIEW = z.looseObject({
  number: z.number().int(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  isCrossRepository: z.boolean(),
  baseRefName: z.string(),
});
const READY_VIEW_FIELDS =
  "number,state,isDraft,headRefName,headRefOid,isCrossRepository,baseRefName";
// The saved stages an authorization ready-pr acts on is saved at: review,
// as the Reviewer's hardening and integration end, or merge, when a merge
// job readies a PR an interrupted Reviewer left a draft.
const READY_SAVED_STAGES: ReadonlySet<string> = new Set(["review", "merge"]);

function viewForReady(cfg: Config, pr: number): z.infer<typeof READY_VIEW> {
  const args = ["pr", "view", String(pr), "-R", cfg.repo];
  const view = READY_VIEW.safeParse(
    ghJson(cfg, "merge", [...args, "--json", READY_VIEW_FIELDS]),
  );
  if (!view.success) {
    throw new OpsError(
      `GitHub's reply for PR #${pr} doesn't parse: ${z.prettifyError(view.error)}`,
    );
  }
  return view.data;
}

// Whether `saved` holds the same merge authorization as `state`: the same
// hardened revision and the same authorized revision (mergeAuthorization).
function sameAuthorization(saved: IssueState, state: IssueState): boolean {
  const authorized = mergeAuthorization(state);
  const savedAuthorized = mergeAuthorization(saved);
  return (
    authorized !== null &&
    savedAuthorized !== null &&
    state.hardened !== null &&
    saved.hardened !== null &&
    sameRevision(saved.hardened, state.hardened) &&
    sameRevision(savedAuthorized, authorized)
  );
}

// The PR and authorized code head ready-pr may mark ready, after checking
// that the request's state is the issue's, that it and the issue's freshly
// saved state (at review or merge) hold the same PR and the same merge
// authorization (so it is saved before the PR is ready), and that the
// authorization holds for the issue's revision read fresh. A state with no
// hardening authorizes nothing. Throws otherwise.
function readyApproval(
  cfg: Config,
  n: number,
  state: IssueState,
): { pr: number; code: string } {
  const { pr } = state;
  if (state.number !== n) {
    throw new OpsError(`ready-pr was given #${state.number}'s state for #${n}`);
  }
  if (pr === null) {
    throw new OpsError(`#${n} has no PR to mark ready`);
  }
  const authorized = mergeAuthorization(state);
  if (authorized === null || authorized.code === null) {
    throw new OpsError(
      `#${n} has no hardened authorization of code to mark PR #${pr} ready`,
    );
  }
  const { state: saved } = readState(cfg, n);
  if (
    saved === null ||
    !READY_SAVED_STAGES.has(saved.stage) ||
    saved.pr !== pr ||
    !sameAuthorization(saved, state)
  ) {
    throw new OpsError(
      `#${n}'s saved state doesn't hold PR #${pr}'s hardened authorization of ${authorized.code} at review or merge; save it before ready-pr`,
    );
  }
  assignedBranch(cfg, n, saved);
  const current = currentRevision(cfg, n, state);
  if (!approvalHolds(state, current.revision)) {
    const { code, inputs } = current.revision;
    throw new OpsError(
      `#${n}'s merge authorization doesn't hold for its current revision (code ${String(code)}, inputs ${inputs})`,
    );
  }
  return { pr, code: authorized.code };
}

// Throws unless GitHub shows PR `pr` open, from the issue's own branch, at
// the authorized head `code`.
function assertReadyView(
  cfg: Config,
  n: number,
  pr: number,
  { code, view }: { code: string; view: z.infer<typeof READY_VIEW> },
): void {
  assertPrBase(cfg, pr, view.baseRefName);
  const branch = paths.branch(cfg, n);
  if (
    view.number !== pr ||
    view.headRefName !== branch ||
    view.isCrossRepository
  ) {
    throw new OpsError(`PR #${pr} is not from ${cfg.repo}'s ${branch}`);
  }
  if (view.state !== "OPEN" || view.headRefOid !== code) {
    throw new OpsError(
      `PR #${pr} is ${view.state} at ${view.headRefOid}, not open at the authorized ${code}`,
    );
  }
}

// Marks the issue's PR ready for review once the Reviewer's hardening
// authorized its exact revision (readyApproval) and GitHub shows it open at
// the authorized head. Safe to repeat: a PR already ready succeeds without a
// write. A failed ready, or a PR GitHub still shows as a draft or at another
// head after it, throws.
function readyPr(cfg: Config, request: unknown): ReadyReply {
  const req = parseRequest(READY_REQUEST, "ready-pr", request);
  const n = req.number;
  const { pr, code } = readyApproval(cfg, n, req.state);
  const view = viewForReady(cfg, pr);
  assertReadyView(cfg, n, pr, { code, view });
  if (!view.isDraft) {
    return { pr, ready: true };
  }
  gh(cfg, "dev", ["pr", "ready", String(pr), "-R", cfg.repo]);
  const after = viewForReady(cfg, pr);
  assertReadyView(cfg, n, pr, { code, view: after });
  if (after.isDraft) {
    throw new OpsError(`gh marked PR #${pr} ready, but GitHub shows a draft`);
  }
  return { pr, ready: true };
}

export type { ReadyReply };
export { readyPr };
