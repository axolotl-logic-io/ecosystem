// What happens once an issue leaves the pipeline or ends a sweep: the
// bookkeeping after its PR merges, closing a parent whose sub-issues are all
// closed, posting queued comments, and keeping an unfinished issue's lease.

import { z } from "zod";
import { touchClaim } from "../claims.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gh, ghJson } from "../github.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { parseRequest } from "../process.ts";
import type { State } from "../state.ts";
import { STATE, writeState } from "../state.ts";
import type { WikiPublish } from "../wiki-publish.ts";
import { publishMerged } from "./publish.ts";

const SUB_ISSUES_PER_PAGE = 100;

// gh's answer, or null when it printed nothing.
const SUB_ISSUES = z
  .array(z.looseObject({ number: z.number(), state: z.unknown() }))
  .nullable();

const ISSUE_REQUEST = z.looseObject({ number: z.number().int() });
const FINISH_WIKI_REQUEST = z.looseObject({
  number: z.number().int(),
  state: STATE,
});
// The lane fields are whatever the workflow sent (LaneRequest in claims.ts).
const RELEASE_REQUEST = z.looseObject({
  lane: z.unknown().optional(),
  number: z.number().int(),
  state: STATE,
  sweepId: z.unknown().optional(),
});

type CloseParentReply =
  | { closed: false; reason: string }
  | { closed: false; open: number[] }
  | { closed: true };

type EmptyReply = Record<string, never>;

type FinishWikiReply = { merged: true } & WikiPublish;

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  return undefined;
}

// Deletes the issue's code branch on GitHub, if it is there.
function deleteBranch(cfg: Config, n: number): void {
  gh(
    cfg,
    [
      "api",
      "-X",
      "DELETE",
      `repos/${cfg.repo}/git/refs/heads/${paths.branch(n)}`,
      "--silent",
    ],
    { allowFail: true },
  );
}

// After a PR merges, by the pipeline or by hand: delete the branch, label the
// PR, then publish the issue's wiki changes, which finishes the issue. True
// when it published. Otherwise (a wiki conflict, or an error) the issue waits
// at the publish stage, open, with its claim, lease and worktree.
function finishMerged(
  cfg: Config,
  n: number,
  pr: number,
  state: State,
): boolean {
  deleteBranch(cfg, n);
  setLabels(cfg, pr, [LABELS.merged.name], [LABELS.working.name]);
  clearStopLabels(cfg, pr);
  try {
    if (publishMerged(cfg, n, pr, state).published) {
      return true;
    }
  } catch (error) {
    comment(
      cfg,
      n,
      { role: "merger" },
      `The wiki changes from this issue were not published: ${String(errorMessage(error))}. The pipeline will retry the publish.`,
    );
  }
  writeState(cfg, n, { ...state, stage: "publish" });
  return false;
}

// Finishes an issue whose change lives only in the wiki, in place of a merge:
// deletes its code branch, publishes its wiki commits and closes it as
// merged. A conflict leaves it waiting at the publish stage with the
// conflict in the reply; a push that keeps failing throws.
function finishWiki(cfg: Config, request: unknown): FinishWikiReply {
  const req = parseRequest(FINISH_WIKI_REQUEST, "finish-wiki", request);
  const n = req.number;
  deleteBranch(cfg, n);
  const published = publishMerged(cfg, n, null, req.state);
  if (!published.published) {
    writeState(cfg, n, { ...req.state, stage: "publish" });
  }
  return { merged: true, ...published };
}

// Closes a split issue once every sub-issue is closed.
function closeParent(cfg: Config, request: unknown): CloseParentReply {
  const { number: n } = parseRequest(ISSUE_REQUEST, "close-parent", request);
  const subs =
    SUB_ISSUES.parse(
      ghJson(cfg, [
        "api",
        `repos/${cfg.repo}/issues/${n}/sub_issues?per_page=${SUB_ISSUES_PER_PAGE}`,
      ]),
    ) ?? [];
  if (subs.length === 0) {
    return { closed: false, reason: "no sub-issues found" };
  }
  const open = subs
    .filter((sub) => sub.state !== "closed")
    .map((sub) => sub.number);
  if (open.length > 0) {
    return { closed: false, open };
  }
  const list = subs.map((sub) => `#${sub.number}`).join(", ");
  comment(
    cfg,
    n,
    { role: "coordinator" },
    `All sub-issues are closed (${list}). Closing.`,
  );
  gh(cfg, ["issue", "close", String(n), "-R", cfg.repo]);
  setLabels(cfg, n, [LABELS.merged.name], [LABELS.split.name]);
  return { closed: true };
}

// Only posts the queued comments (the ops CLI does that before any op).
function post(): EmptyReply {
  return {};
}

// The lease with its time renewed, or null when there is none.
function renewed(lease: unknown): { at: string } | null {
  if (typeof lease !== "object" || lease === null) {
    return null;
  }
  return { ...lease, at: new Date().toISOString() };
}

// The sweep ends with the issue unfinished. Its lane keeps the lease and its
// claim, and its next sweep continues the issue. If the lane never comes back,
// the lease and claim expire after leaseHours and another lane may take it.
function release(cfg: Config, request: unknown): EmptyReply {
  const req = parseRequest(RELEASE_REQUEST, "release", request);
  const { lease } = req.state;
  writeState(cfg, req.number, { ...req.state, lease: renewed(lease) });
  touchClaim(cfg, req.number, req);
  return {};
}

export { closeParent, finishMerged, finishWiki, post, release };
