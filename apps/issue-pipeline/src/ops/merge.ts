// The decision to merge an issue's PR or refuse it: the checks that the
// request's revision is the state's approved one (approvedRevision), that it
// is still the PR's head and still current, the merge order between issues,
// the base check, that the Reviewer marked the PR ready, the squash merge
// itself and the merge receipt. A merge only merges code: publishing the
// wiki (publish) and closing the issue (finish-wiki) are separate ops the
// merge role runs after it saves the receipt (`merge-publish-finish-split`).

import { z } from "zod";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths, wikiCfg } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { gh, ghJson, git } from "../github.ts";
import type { RunResult } from "../process.ts";
import { OpsError, parseRequest, run, tail } from "../process.ts";
import { currentRevision } from "../revision.ts";
import { approvalHolds, ISSUE_STATE } from "../state.ts";
import { mergedText } from "./merge-comment.ts";
import type { Queued } from "./merge-order.ts";
import { queued } from "./merge-order.ts";
import type { MergeStale } from "./publication-guard.ts";
import { mergeStale, REVISION_REQUEST } from "./publication-guard.ts";

const REFUSAL_TAIL_LINES = 5;
const BASE_MOVED =
  /base branch was modified|not up to date with the base|head branch is not up to date/iu;
const NEEDS_APPROVAL =
  /approving review|review is required|reviews? required|approv/iu;
const APPROVAL_HINT =
  " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config.";

// gh's answer to the PR view.
const PR_VIEW = z.looseObject({
  headRefName: z.string(),
  headRefOid: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  mergeCommit: z.looseObject({ oid: z.string() }).nullish(),
  state: z.string(),
});
const PR_VIEW_FIELDS =
  "headRefName,headRefOid,state,mergeable,mergeStateStatus,isDraft,mergeCommit";
const MERGE_REQUEST = z.looseObject({
  expectedSha: z.string().min(1),
  mergeOrder: z.boolean().nullish(),
  // The merge order the orchestrator ranked (#234), which replaces the
  // lowest-PR order when given.
  mergeQueue: z.array(z.number().int()).nullish(),
  number: z.number().int(),
  // The state's approved revision (approvedRevision), which must still be
  // current.
  revision: REVISION_REQUEST,
  state: ISSUE_STATE.extend({ pr: z.number().int().positive() }),
  summary: z.string().nullish(),
});

type PrView = z.infer<typeof PR_VIEW>;
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
  // Reviewer's approval.
  | { merged: false; reason: "draft" }
  | WikiRefusal
  | MergeStale
  | Queued;

function viewPr(cfg: Config, pr: number): PrView {
  return PR_VIEW.parse(
    ghJson(cfg, [
      "pr",
      "view",
      String(pr),
      "-R",
      cfg.repo,
      "--json",
      PR_VIEW_FIELDS,
    ]),
  );
}

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
// state's approved one, the expected head is its code, and the PR is from
// the issue's branch.
function checkedView(cfg: Config, req: MergeRequest): PrView {
  if (!approvalHolds(req.state, req.revision)) {
    throw new OpsError(
      `merge revision (code ${String(req.revision.code)}, wiki ${String(req.revision.wiki)}) is not #${req.number}'s approved revision`,
    );
  }
  if (req.expectedSha !== req.revision.code) {
    throw new OpsError(
      `merge expectedSha ${req.expectedSha} is not the approved code ${String(req.revision.code)}`,
    );
  }
  const view = viewPr(cfg, req.state.pr);
  const branch = paths.branch(req.number);
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
  git(cfg, ["-C", dir, "fetch", "origin", refspec]);
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

// What a failed `gh pr merge` means for the issue.
function mergeRefusal(result: RunResult): MergeReply {
  const why = tail(result.stderr || result.stdout, REFUSAL_TAIL_LINES);
  // Another PR merged first. The next sync rebases and the issue is
  // reviewed again, as for "behind".
  if (BASE_MOVED.test(why)) {
    return { merged: false, reason: "behind" };
  }
  let hint = "";
  if (NEEDS_APPROVAL.test(why)) {
    hint = APPROVAL_HINT;
  }
  return { merged: false, reason: `merge refused: ${why}${hint}` };
}

// Squash-merges the issue's PR at the approved commit and returns GitHub's
// merge receipt, or says why not. It writes no state, labels or wiki: the
// role saves the receipt, then publishes and finishes.
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
  // The account that opened the PR can't approve it, so there is no review
  // step; the signed comment below records the verdict instead.
  const args = ["pr", "merge", String(pr), "-R", cfg.repo, "--squash"];
  args.push("--match-head-commit", req.expectedSha);
  const { mergeAdmin } = cfg;
  if (mergeAdmin) {
    args.push("--admin");
  }
  const result = gh(cfg, args, { allowFail: true });
  if (result.code !== 0) {
    return mergeRefusal(result);
  }
  const after = viewPr(cfg, pr);
  if (after.state !== "MERGED" || after.headRefOid !== req.expectedSha) {
    throw new OpsError(
      `gh merged PR #${pr}, but GitHub shows it ${after.state} at ${after.headRefOid}`,
    );
  }
  const mergeCommit = mergeCommitOf(pr, after);
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
