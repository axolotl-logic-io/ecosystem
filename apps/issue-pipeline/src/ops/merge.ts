// The decision to merge an issue's PR or refuse it: the checks that the
// verified commit is still the PR's head and contains the current base, the
// merge order between issues, the squash merge itself and what a refusal means.

import { z } from "zod";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { fetchIn } from "../git-state.ts";
import { gh, ghJson } from "../github.ts";
import { LABELS } from "../labels.ts";
import type { RunResult } from "../process.ts";
import { parseRequest, run, tail } from "../process.ts";
import { readState, STATE } from "../state.ts";
import { isStopLabel } from "../stops.ts";
import { finishMerged } from "./finish.ts";

const MS_PER_HOUR = 3_600_000;
const WORKING_LIST_LIMIT = "100";
const SHORT_SHA_LENGTH = 12;
const REFUSAL_TAIL_LINES = 5;
const BASE_MOVED =
  /base branch was modified|not up to date with the base|head branch is not up to date/iu;
const NEEDS_APPROVAL =
  /approving review|review is required|reviews? required|approv/iu;
const APPROVAL_HINT =
  " Branch protection requires an approving review, which the pipeline's own account can't give. Drop the approval rule, give the account a bypass, or set mergeAdmin in the config.";

// Stages after review, where an issue only waits to merge.
const READY_STAGES: ReadonlySet<string> = new Set([
  "sync",
  "checks",
  "accept",
  "security",
  "merge",
]);

// gh's answers, and the part of another issue's state the merge order reads.
const PR_VIEW = z.looseObject({
  headRefOid: z.string(),
  isDraft: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  state: z.string(),
});
const WORKING = z
  .array(
    z.looseObject({
      labels: z.array(z.looseObject({ name: z.string() })),
      number: z.number(),
    }),
  )
  .nullable();
const READY_STATE = z.looseObject({
  lease: z.looseObject({ at: z.string().nullish() }).nullish(),
  pr: z.number().positive(),
  stage: z.string(),
});

const MERGE_REQUEST = z.looseObject({
  expectedSha: z.string(),
  mergeOrder: z.boolean().nullish(),
  number: z.number().int(),
  state: STATE.extend({ pr: z.number() }),
  summary: z.string().nullish(),
});

type PrView = z.infer<typeof PR_VIEW>;
type MergeRequest = z.infer<typeof MERGE_REQUEST>;

// The merge waits for issue #waitingFor, whose PR #waitingForPr is older.
interface Queued {
  merged: false;
  reason: "queued";
  waitingFor: number;
  waitingForPr: number;
}

type MergeReply =
  | { merged: true; byHand: true }
  | { merged: true }
  | { merged: false; reason: string }
  | { merged: false; reason: "head-changed"; headSha: string }
  | Queued;

interface Ahead {
  number: number;
  pr: number;
}

// The PR of issue #number when it should merge before PR `pr`: past review,
// with an older PR and a lease that hasn't expired (a crashed sweep).
function readyPr(
  cfg: Config,
  number: number,
  pr: number,
  leaseMs: number,
): number | undefined {
  const parsed = READY_STATE.safeParse(readState(cfg, number).state);
  if (!parsed.success) {
    return undefined;
  }
  const { data } = parsed;
  if (data.pr >= pr || !READY_STAGES.has(data.stage)) {
    return undefined;
  }
  const at = data.lease?.at;
  const leased = at !== undefined && at !== null && at !== "";
  if (leased && Date.now() - Date.parse(at) >= leaseMs) {
    return undefined;
  }
  return data.pr;
}

// The open issue, other than #n, that should merge before PR `pr`: one past
// review whose PR is older. Without this, a slow issue's long verify keeps
// losing the merge to quick issues in the other slots.
function olderReadyIssue(cfg: Config, n: number, pr: number): Ahead | null {
  const listed = ghJson(cfg, [
    "issue",
    "list",
    "-R",
    cfg.repo,
    "--state",
    "open",
    "--label",
    LABELS.working.name,
    "--limit",
    WORKING_LIST_LIMIT,
    "--json",
    "number,labels",
  ]);
  const leaseMs = cfg.leaseHours * MS_PER_HOUR;
  let best: Ahead | null = null;
  for (const issue of WORKING.parse(listed) ?? []) {
    const stopped = issue.labels.some((label) => isStopLabel(label.name));
    if (issue.number !== n && !stopped) {
      const older = readyPr(cfg, issue.number, pr, leaseMs);
      if (older !== undefined && (best === null || older < best.pr)) {
        best = { number: issue.number, pr: older };
      }
    }
  }
  return best;
}

function queued(cfg: Config, req: MergeRequest): Queued | undefined {
  if (req.mergeOrder !== true) {
    return undefined;
  }
  const ahead = olderReadyIssue(cfg, req.number, req.state.pr);
  if (ahead === null) {
    return undefined;
  }
  return {
    merged: false,
    reason: "queued",
    waitingFor: ahead.number,
    waitingForPr: ahead.pr,
  };
}

// Why the open PR may not merge yet, or undefined when it may.
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
    finishMerged(cfg, n, pr, req.state);
    return { merged: true, byHand: true };
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
  finishMerged(cfg, n, pr, req.state);
  return { merged: true };
}

export { merge };
