// The decision to merge an issue's PR or refuse it: the checks that the
// request's revision is the state's authorized one (mergeAuthorization),
// that it is still the PR's head and still current, the merge order between
// issues, the base check, that the Reviewer marked the PR ready, the explicit-target branch
// merge itself and the merge receipt. A merge only merges code: publishing
// the wiki (publish) and closing the issue (finish-wiki) are separate ops
// the merge role runs after it saves the receipt and the security review of
// the merged result (`merge-publish-finish-split`).

import { z } from "zod";
import { assignedBranch } from "../branch-binding.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { git } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest, run } from "../process.ts";
import { confirmMerged, currentRevision } from "../revision.ts";
import { approvalHolds, ISSUE_STATE } from "../state.ts";
import { branchMerge } from "./branch-merge.ts";
import { mergedText } from "./merge-comment.ts";
import type { Queued } from "./merge-order.ts";
import { queued } from "./merge-order.ts";
import { FULL_SHA, mergedParent } from "./merged-graph.ts";
import type { PrView } from "./pr-merge.ts";
import { viewForMerge } from "./pr-merge.ts";
import type { MergeStale } from "./publication-guard.ts";
import { mergeStale, REVISION_REQUEST } from "./publication-guard.ts";

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

// The merge receipt: GitHub's merge commit and the PR head it merged. byHand
// when the PR had merged before this op, so the head may not be the approved
// one; the role compares headSha with its approval.
// The approved wiki head can't be published as approved after the merge:
// the wiki's branch moved past it (wiki-behind), or the issue's wiki
// checkout doesn't hold it (wiki-missing).
interface WikiRefusal {
  merged: false;
  reason: "wiki-behind" | "wiki-missing";
  detail: string;
}

type MergeReply =
  | { merged: true; mergeCommit: string; headSha: string }
  | { merged: true; byHand: true; mergeCommit: string; headSha: string }
  | { merged: false; reason: string }
  | { merged: false; reason: "head-changed"; headSha: string }
  // The PR is still a draft: only ready-pr marks it ready, after the
  // Reviewer's hardening authorized it.
  | { merged: false; reason: "draft" }
  | WikiRefusal
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
      `merge revision (code ${String(req.revision.code)}, wiki ${String(req.revision.wiki)}) is not #${req.number}'s authorized revision`,
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
): "conflict" | "behind" | undefined {
  if (view.mergeable === "CONFLICTING") {
    return "conflict";
  }
  if (view.mergeStateStatus === "BEHIND") {
    return "behind";
  }
  const wt = paths.worktree(cfg, req.number);
  fetchIn(cfg, wt, cfg.baseBranch);
  const base = `origin/${cfg.baseBranch}`;
  const args = ["-C", wt, "merge-base", "--is-ancestor", base, req.expectedSha];
  if (run("git", args, { allowFail: true }).code !== 0) {
    return "behind";
  }
  return undefined;
}

// Whether the issue's wiki checkout holds the approved wiki head, and it
// still fast-forwards the wiki's branch, so the publish after the merge needs
// no unreviewed rebase. Merging code whose wiki can't then be published as
// approved would leave it half done.
function wikiBehind(cfg: Config, req: MergeRequest): WikiRefusal | undefined {
  const wiki = wikiCfg(cfg);
  const approved = req.revision.wiki;
  if (wiki === null || approved === null) {
    return undefined;
  }
  const dir = paths.wiki(cfg, req.number);
  const holds = ["-C", dir, "cat-file", "-e", `${approved}^{commit}`];
  if (run("git", holds, { allowFail: true }).code !== 0) {
    return {
      merged: false,
      reason: "wiki-missing",
      detail: `the issue's wiki checkout doesn't hold the approved wiki commit ${approved}, so nothing was merged or published`,
    };
  }
  const refspec = `+refs/heads/${wiki.branch}:refs/remotes/origin/${wiki.branch}`;
  git(cfg, "dev", ["-C", dir, "fetch", "origin", refspec]);
  const base = `origin/${wiki.branch}`;
  const args = ["-C", dir, "merge-base", "--is-ancestor", base, approved];
  if (run("git", args, { allowFail: true }).code === 0) {
    return undefined;
  }
  return {
    merged: false,
    reason: "wiki-behind",
    detail: `${base} moved past the approved wiki commit ${approved}`,
  };
}

// Why the open PR may not merge yet, or undefined when it may. The merge
// order comes before the fresh revision and base checks, so only the issue
// at the head of the queue is told to rebase (#422). A draft is refused, and
// never marked ready here.
function precheck(
  cfg: Config,
  req: MergeRequest,
  view: PrView,
): MergeReply | undefined {
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
  const stale = mergeStale(
    req.revision,
    currentRevision(cfg, req.number, req.state),
  );
  if (stale !== undefined) {
    return stale;
  }
  const behind = staleReason(cfg, req, view);
  if (behind !== undefined) {
    return { merged: false, reason: behind };
  }
  if (view.isDraft) {
    return { merged: false, reason: "draft" };
  }
  return wikiBehind(cfg, req);
}

// Names the configured destination and immutable authorized source, not the
// PR's mutable target/head refs. Observations below are not a transaction
// with PR/input/wiki state or with concurrent integration changes.
function merge(cfg: Config, request: unknown): MergeReply {
  const req = parseRequest(MERGE_REQUEST, "merge", request);
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
  const refused = precheck(cfg, req, view);
  if (refused !== undefined) {
    return refused;
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
  return attemptedMerge(cfg, req);
}

// After entering the mutation boundary, errors must be a durable refusal,
// not an OpsFailure that a generic transient handler could defer/retry.
function attemptedMerge(cfg: Config, req: MergeRequest): MergeReply {
  try {
    const result = branchMerge(cfg, req.expectedSha);
    if ("reason" in result) {
      return result;
    }
    return ownReceipt(cfg, req, result.sha);
  } catch (error) {
    let detail = "unreadable result evidence";
    if (error instanceof Error) {
      detail = error.message;
    }
    return {
      merged: false,
      reason: `merge result cannot be confirmed; code may already have landed; stop for read-only reconciliation, not a mutation retry: ${detail}`,
    };
  }
}

// A response label is not evidence of shape, PR identity or reachability.
// Failures here can follow a real landing; no second merge manufactures a
// receipt. Saving this confirmed receipt belongs to the role.
function ownReceipt(
  cfg: Config,
  req: MergeRequest,
  mergeCommit: string,
): MergeReply {
  const { pr } = req.state;
  const { expectedSha: head } = req;
  const after = checkedView(cfg, req);
  if (
    after.state !== "MERGED" ||
    after.headRefOid !== head ||
    mergeCommitOf(pr, after) !== mergeCommit
  ) {
    throw new OpsError(
      `branch merge returned ${mergeCommit}, but PR #${pr} is not MERGED at exactly that result and retained head ${head}; code may already have landed`,
    );
  }
  const wt = paths.worktree(cfg, req.number);
  confirmMerged(cfg, req.number, { wt, codeMerged: { pr, sha: mergeCommit } });
  // The API supplies no always-no-ff guarantee. Inspect fetched objects;
  // unsupported results may already be on integration, but cannot complete.
  mergedParent(wt, mergeCommit, head, true);
  comment(
    cfg,
    pr,
    { role: "merger" },
    `${mergedText(req.state, req.expectedSha, mergeCommit)}\n\n${req.summary ?? ""}`,
  );
  return { merged: true, mergeCommit, headSha: req.expectedSha };
}

export type { MergeReply };
export { merge };
