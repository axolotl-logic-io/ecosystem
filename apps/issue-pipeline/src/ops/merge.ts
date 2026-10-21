// Merge code only: validate exact-head authorization, queue, base and
// readiness before the explicit-target merge and durable receipt. Issue
// completion is a separate operation, after actual-result checks and
// security (`merge-publish-finish-split`).

import { z } from "zod";
import { assignedBranch } from "../branch-binding.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { FULL_SHA } from "../merge-provenance.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
import { currentRevision } from "../revision.ts";
import { readWriteState } from "../saved-state.ts";
import { approvalHolds, ISSUE_STATE } from "../state.ts";
import { assertFastForward, branchMerge } from "./branch-merge.ts";
import { beginMerge, saveMergeResponse } from "./merge-attempt.ts";
import { mergedText } from "./merge-comment.ts";
import type { MergeStale } from "./merge-guard.ts";
import { mergeStale, REVISION_REQUEST } from "./merge-guard.ts";
import type { Queued } from "./merge-order.ts";
import { queued } from "./merge-order.ts";
import type { ConfirmationClock } from "./merge-recovery.ts";
import { diagnostic, reconcileMerge } from "./merge-recovery.ts";
import { approvePr } from "./pr-approval.ts";
import type { PrView } from "./pr-merge.ts";
import { viewForMerge } from "./pr-merge.ts";

const MERGE_REQUEST = z.looseObject({
  expectedSha: FULL_SHA,
  mergeOrder: z.boolean().nullish(),
  // The merge order the orchestrator ranked (#234), which replaces the
  // lowest-PR order when given.
  mergeQueue: z.array(z.number().int()).nullish(),
  number: z.number().int(),
  // The state's authorized revision (mergeAuthorization), which must still
  // be current.
  revision: REVISION_REQUEST,
  state: ISSUE_STATE.extend({ pr: z.number().int().positive() }),
  summary: z.string().nullish(),
});

type MergeRequest = z.infer<typeof MERGE_REQUEST>;

// byHand receipts may have an unapproved head; the role compares it to approval.
type MergeReply =
  | { merged: true; mergeCommit: string; headSha: string }
  | { merged: true; byHand: true; mergeCommit: string; headSha: string }
  | { merged: false; reason: string }
  | { merged: false; reason: "head-changed"; headSha: string }
  // The PR is still a draft: only ready-pr marks it ready, after the
  // Reviewer's hardening authorized it.
  | { merged: false; reason: "draft" }
  | MergeStale
  | Queued;

// The merge commit GitHub reports for a merged PR; a merged PR without one
// is an error, never an empty receipt.
function mergeCommitOf(pr: number, view: PrView): string {
  const oid = view.mergeCommit?.oid ?? "";
  if (oid === "") {
    throw new OpsError(
      `PR #${pr} is MERGED but GitHub reports no merge commit`,
    );
  }
  return oid;
}

// The PR view, once the request and PR are consistent: the revision is the
// state's authorized one, the expected head is its code, and the PR is from
// the issue's branch.
function checkedView(cfg: Config, req: MergeRequest): PrView {
  if (!approvalHolds(req.state, req.revision)) {
    throw new OpsError(
      `merge revision (code ${String(req.revision.code)}) is not #${req.number}'s authorized revision`,
    );
  }
  if (req.expectedSha !== req.revision.code) {
    throw new OpsError(
      `merge expectedSha ${req.expectedSha} is not the approved code ${String(req.revision.code)}`,
    );
  }
  const view = viewForMerge(cfg, req.state.pr);
  const branch = assignedBranch(cfg, req.number, req.state);
  if (view.headRefName !== branch) {
    throw new OpsError(
      `PR #${req.state.pr} is from ${view.headRefName}, not ${branch}`,
    );
  }
  return view;
}

// Whether the verified commit lacks the current base: GitHub calls the PR
// conflicting or behind, or, since without branch protection GitHub merges
// a stale branch without complaint, the commit lacks the base's latest
// commit locally.
function staleReason(
  cfg: Config,
  req: MergeRequest,
  view: PrView,
  base: string,
): "conflict" | "behind" | undefined {
  if (view.mergeable === "CONFLICTING") {
    return "conflict";
  }
  if (view.mergeStateStatus === "BEHIND") {
    return "behind";
  }
  const wt = paths.worktree(cfg, req.number);
  const args = ["-C", wt, "merge-base", "--is-ancestor", base, req.expectedSha];
  if (run("git", args, { allowFail: true }).code !== 0) {
    return "behind";
  }
  return undefined;
}

// Why the open PR may not merge yet, or undefined when it may. The merge
// order comes before the fresh revision and base checks, so only the issue
// at the head of the queue is told to rebase (#422). A draft is refused, and
// never marked ready here.
function precheck(
  cfg: Config,
  req: MergeRequest,
  view: PrView,
): MergeReply | { base: string } {
  if (view.state !== "OPEN") {
    return { merged: false, reason: `PR is ${view.state}` };
  }
  if (view.headRefOid !== req.expectedSha) {
    return { merged: false, reason: "head-changed", headSha: view.headRefOid };
  }
  const waits = queued(cfg, req);
  if (waits !== undefined) {
    return waits;
  }
  const current = currentRevision(cfg, req.number, req.state);
  const stale = mergeStale(req.revision, current);
  if (stale !== undefined) {
    return stale;
  }
  const behind = staleReason(cfg, req, view, current.baseSha);
  if (behind !== undefined) {
    return { merged: false, reason: behind };
  }
  if (view.isDraft) {
    return { merged: false, reason: "draft" };
  }
  return { base: FULL_SHA.parse(current.baseSha) };
}

// Names the configured destination and immutable authorized source, not the
// PR's mutable target/head refs. Observations below are not a transaction
// with PR/input state or with concurrent integration changes.
function merge(
  cfg: Config,
  request: unknown,
  clock?: ConfirmationClock,
): MergeReply {
  const req = parseRequest(MERGE_REQUEST, "merge", request);
  // A replay must enter read-only recovery before approval or premerge work,
  // even if the caller still holds its pre-attempt snapshot and PR looks OPEN.
  if (readWriteState(cfg, req.number).mergeAttempt !== null) {
    return reconcileMerge(cfg, { number: req.number }, clock);
  }
  const { pr } = req.state;
  const view = checkedView(cfg, req);
  if (view.state === "MERGED") {
    // Someone merged it first, by hand or in a run that crashed before it
    // saved the receipt.
    const mergeCommit = mergeCommitOf(pr, view);
    return {
      merged: true,
      byHand: true,
      mergeCommit,
      headSha: view.headRefOid,
    };
  }
  const checked = precheck(cfg, req, view);
  if (!("base" in checked)) {
    return checked;
  }
  // A last observation refuses an already invalid PR; it is not atomic
  // current-PR authority. Retargeting cannot redirect the explicit request.
  const fresh = checkedView(cfg, req);
  if (fresh.state !== "OPEN") {
    return { merged: false, reason: `PR is ${fresh.state}` };
  }
  if (fresh.headRefOid !== req.expectedSha) {
    return { merged: false, reason: "head-changed", headSha: fresh.headRefOid };
  }
  if (fresh.isDraft) {
    return { merged: false, reason: "draft" };
  }
  assertFastForward(
    paths.worktree(cfg, req.number),
    checked.base,
    req.expectedSha,
  );
  approvePr(cfg, pr, req.expectedSha);
  return attemptedMerge(cfg, req, checked.base, clock);
}

// After entering the mutation boundary, errors must be a durable refusal,
// not an OpsFailure that a generic transient handler could defer/retry.
function attemptedMerge(
  cfg: Config,
  req: MergeRequest,
  base: string,
  clock?: ConfirmationClock,
): MergeReply {
  beginMerge(cfg, req.number, req.state.pr, { authorized: req.revision, base });
  try {
    const result = branchMerge(
      cfg,
      paths.worktree(cfg, req.number),
      base,
      req.expectedSha,
    );
    if (result) {
      saveMergeResponse(cfg, req.number, req.expectedSha);
    }
    const receipt = reconcileMerge(cfg, { number: req.number }, clock);
    if (receipt.merged && receipt.byHand !== true) {
      comment(
        cfg,
        req.state.pr,
        { role: "merger" },
        `${mergedText(req.state, req.expectedSha, receipt.mergeCommit)}\n\n${req.summary ?? ""}`,
      );
    }
    return receipt;
  } catch (error) {
    let detail = "unreadable result evidence";
    if (error instanceof Error) {
      detail = error.message;
    }
    return diagnostic(detail);
  }
}

export type { MergeReply };
export { merge };
