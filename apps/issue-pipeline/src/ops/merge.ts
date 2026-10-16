// The decision to merge an issue's PR or refuse it: the checks that the
// verified commit is still the PR's head, contains the current base and isn't
// stacked on another issue's branch, the merge order between issues, the squash merge itself and what a refusal means.

import { z } from "zod";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { gh, ghJson } from "../github.ts";
import type { RunResult } from "../process.ts";
import { parseRequest, run, tail } from "../process.ts";
import { STATE } from "../state.ts";
import { finishMerged } from "./finish.ts";
import type { Queued } from "./merge-order.ts";
import { queued } from "./merge-order.ts";

const SHORT_SHA_LENGTH = 12;
const REFUSAL_TAIL_LINES = 5;
const BASE_MOVED =
  /base branch was modified|not up to date with the base|head branch is not up to date/iu;
const NEEDS_APPROVAL =
  /approving review|review is required|reviews? required|approv/iu;
const APPROVAL_HINT =
  " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config.";

// gh's answer to the PR view.
const PR_VIEW = z.looseObject({
  headRefOid: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  state: z.string(),
});
const MERGE_REQUEST = z.looseObject({
  expectedSha: z.string(),
  mergeOrder: z.boolean().nullish(),
  // The merge order the orchestrator ranked (#234), which replaces the
  // lowest-PR order when given.
  mergeQueue: z.array(z.number().int()).nullish(),
  number: z.number().int(),
  state: STATE.extend({ pr: z.number() }),
  summary: z.string().nullish(),
});

type PrView = z.infer<typeof PR_VIEW>;
type MergeRequest = z.infer<typeof MERGE_REQUEST>;

type MergeReply =
  | { merged: true; byHand: true; published: boolean }
  | { merged: true; published: boolean }
  | { merged: false; reason: string }
  | { merged: false; reason: "head-changed"; headSha: string }
  | Queued;

// Why the open PR may not merge yet, or undefined when it may.
function precheck(
  cfg: Config,
  req: MergeRequest,
  view: PrView,
): MergeReply | undefined {
  if (view.state !== "OPEN") {
    return { merged: false, reason: `PR is ${view.state}` };
  }
  // A stacked branch (stack.ts) still holds its prerequisite's commits, which
  // its reviews never measured. Like a branch behind its base, it waits for
  // the sync that moves it onto the base once the prerequisite merges.
  const { stackedOn } = req.state;
  if (stackedOn !== null && stackedOn !== undefined) {
    return { merged: false, reason: "behind" };
  }
  if (view.headRefOid !== req.expectedSha) {
    return { merged: false, reason: "head-changed", headSha: view.headRefOid };
  }
  if (view.mergeable === "CONFLICTING") {
    return { merged: false, reason: "conflict" };
  }
  if (view.mergeStateStatus === "BEHIND") {
    return { merged: false, reason: "behind" };
  }
  // Without branch protection GitHub merges a stale branch without complaint,
  // so check here that the verified commit already contains the current base.
  const wt = paths.worktree(cfg, req.number);
  fetchIn(cfg, wt, cfg.baseBranch);
  const base = `origin/${cfg.baseBranch}`;
  const args = ["-C", wt, "merge-base", "--is-ancestor", base, req.expectedSha];
  if (run("git", args, { allowFail: true }).code !== 0) {
    return { merged: false, reason: "behind" };
  }
  return queued(cfg, req);
}

// What a failed `gh pr merge` means for the issue.
function mergeRefusal(result: RunResult): MergeReply {
  const why = tail(result.stderr || result.stdout, REFUSAL_TAIL_LINES);
  // Another PR merged first. The next sweep rebases and re-verifies, as for
  // "behind".
  if (BASE_MOVED.test(why)) {
    return { merged: false, reason: "behind" };
  }
  let hint = "";
  if (NEEDS_APPROVAL.test(why)) {
    hint = APPROVAL_HINT;
  }
  return { merged: false, reason: `merge refused: ${why}${hint}` };
}

// Squash-merges the issue's PR at the verified commit, or says why not.
function merge(cfg: Config, request: unknown): MergeReply {
  const req = parseRequest(MERGE_REQUEST, "merge", request);
  const {
    number: n,
    state: { pr },
  } = req;
  const view = PR_VIEW.parse(
    ghJson(cfg, [
      "pr",
      "view",
      String(pr),
      "-R",
      cfg.repo,
      "--json",
      "headRefOid,state,mergeable,mergeStateStatus,isDraft",
    ]),
  );
  if (view.state === "MERGED") {
    // Someone merged it by hand first. Finish the bookkeeping a merge does.
    const published = finishMerged(cfg, n, pr, req.state);
    return { merged: true, byHand: true, published };
  }
  const refused = precheck(cfg, req, view);
  if (refused !== undefined) {
    return refused;
  }
  // The account that opened the PR can't approve it, so there is no review
  // step; the signed comment below records the verdict instead.
  // GitHub won't merge a draft. open-pr marks it ready, but make sure.
  if (view.isDraft) {
    gh(cfg, ["pr", "ready", String(pr), "-R", cfg.repo], { allowFail: true });
  }
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
  const sha = req.expectedSha.slice(0, SHORT_SHA_LENGTH);
  comment(
    cfg,
    pr,
    { role: "merger" },
    `Merged ${sha}: every blocking review finding is resolved and every check passed on this commit.\n\n${req.summary ?? ""}`,
  );
  const published = finishMerged(cfg, n, pr, req.state);
  return { merged: true, published };
}

export { merge };
