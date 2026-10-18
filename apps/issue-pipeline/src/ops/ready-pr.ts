// ready-pr: the only op that marks an issue's draft PR ready for review,
// once the Reviewer hardened and approved its exact revision and that
// approval is saved. open-pr and merge never mark a PR ready.

import { z } from "zod";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { OpsError, parseRequest } from "../process.ts";
import { currentRevision } from "../revision.ts";
import { readState } from "../saved-state.ts";
import type { IssueState, Revision } from "../state.ts";
import {
  approvalHolds,
  approvedRevision,
  ISSUE_STATE,
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
});
const READY_VIEW_FIELDS =
  "number,state,isDraft,headRefName,headRefOid,isCrossRepository";
// The saved stages an approval ready-pr acts on is saved at: review, as the
// final review ends, or merge, when a merge job readies a PR an interrupted
// review left a draft.
const READY_SAVED_STAGES: ReadonlySet<string> = new Set(["review", "merge"]);

function viewForReady(cfg: Config, pr: number): z.infer<typeof READY_VIEW> {
  const args = ["pr", "view", String(pr), "-R", cfg.repo];
  const view = READY_VIEW.safeParse(
    ghJson(cfg, [...args, "--json", READY_VIEW_FIELDS]),
  );
  if (!view.success) {
    throw new OpsError(
      `GitHub's reply for PR #${pr} doesn't parse: ${z.prettifyError(view.error)}`,
    );
  }
  return view.data;
}

// Whether `state` is approved and hardened as ready-pr needs: its effective
// approval (approvedRevision) for `approved`, and its hardening checkpoint
// at exactly the revision the final review approved (review.revision, never
// an integrated one), so an approval no hardening preceded can't ready a PR.
function approvedAndHardened(state: IssueState, approved: Revision): boolean {
  const effective = approvedRevision(state);
  const { hardened } = state;
  const reviewed = state.review.revision;
  return (
    effective !== null &&
    sameRevision(effective, approved) &&
    hardened !== null &&
    reviewed !== null &&
    sameRevision(hardened, reviewed)
  );
}

// The PR and approved code head ready-pr may mark ready, after checking
// that the request's state is the issue's, that it and the issue's freshly
// saved state (at review or merge) hold the same PR and the same hardened
// approval (so the approval is saved before the PR is ready), and that the
// approval holds for the issue's revision read fresh. Throws otherwise.
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
  const approved = approvedRevision(state);
  if (
    approved === null ||
    approved.code === null ||
    !approvedAndHardened(state, approved)
  ) {
    throw new OpsError(
      `#${n} has no hardened approval of code to mark PR #${pr} ready`,
    );
  }
  const { state: saved } = readState(cfg, n);
  if (
    saved === null ||
    !READY_SAVED_STAGES.has(saved.stage) ||
    saved.pr !== pr ||
    !approvedAndHardened(saved, approved)
  ) {
    throw new OpsError(
      `#${n}'s saved state doesn't hold PR #${pr}'s hardened approval of ${approved.code} at review or merge; save the approval before ready-pr`,
    );
  }
  const current = currentRevision(cfg, n, state);
  if (!approvalHolds(state, current.revision)) {
    const { code, wiki, inputs } = current.revision;
    throw new OpsError(
      `#${n}'s approval doesn't hold for its current revision (code ${String(code)}, wiki ${String(wiki)}, inputs ${inputs})`,
    );
  }
  return { pr, code: approved.code };
}

// Throws unless GitHub shows PR `pr` open, from the issue's own branch, at
// the approved head `code`.
function assertReadyView(
  cfg: Config,
  n: number,
  pr: number,
  { code, view }: { code: string; view: z.infer<typeof READY_VIEW> },
): void {
  const branch = paths.branch(n);
  if (
    view.number !== pr ||
    view.headRefName !== branch ||
    view.isCrossRepository
  ) {
    throw new OpsError(`PR #${pr} is not from ${cfg.repo}'s ${branch}`);
  }
  if (view.state !== "OPEN" || view.headRefOid !== code) {
    throw new OpsError(
      `PR #${pr} is ${view.state} at ${view.headRefOid}, not open at the approved ${code}`,
    );
  }
}

// Marks the issue's PR ready for review once the Reviewer hardened and
// approved its exact revision (readyApproval) and GitHub shows it open at
// the approved head. Safe to repeat: a PR already ready succeeds without a
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
  gh(cfg, ["pr", "ready", String(pr), "-R", cfg.repo]);
  const after = viewForReady(cfg, pr);
  assertReadyView(cfg, n, pr, { code, view: after });
  if (after.isDraft) {
    throw new OpsError(`gh marked PR #${pr} ready, but GitHub shows a draft`);
  }
  return { pr, ready: true };
}

export type { ReadyReply };
export { readyPr };
