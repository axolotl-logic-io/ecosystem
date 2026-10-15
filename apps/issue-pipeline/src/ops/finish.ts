// What happens once an issue leaves the pipeline or ends a sweep: the
// bookkeeping after its PR merges, closing a parent whose sub-issues are all
// closed, posting queued comments, and keeping an unfinished issue's lease.

import { z } from "zod";
import { removeWorktree } from "../checkouts.ts";
import { closeClaims, touchClaim } from "../claims.ts";
import { comment } from "../comments.ts";
import type { Config } from "../config.ts";
import { paths } from "../config.ts";
import { gh, ghJson, issueState } from "../github.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { parseRequest } from "../process.ts";
import type { State } from "../state.ts";
import { STATE, writeState } from "../state.ts";
import { pushWiki } from "../wiki.ts";

const SHORT_SHA_LENGTH = 12;
const SUB_ISSUES_PER_PAGE = 100;

// gh's answer, or null when it printed nothing.
const SUB_ISSUES = z
  .array(z.looseObject({ number: z.number(), state: z.unknown() }))
  .nullable();

const ISSUE_REQUEST = z.looseObject({ number: z.number().int() });
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

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }
  return undefined;
}

// Pushes the issue's wiki commits and says so on the issue. False when the
// push failed: the worktree, and its wiki commits, stay for a person to push.
function pushIssueWiki(cfg: Config, n: number): boolean {
  try {
    const pushed = pushWiki(cfg, n);
    if (pushed?.pushed === true) {
      comment(
        cfg,
        n,
        { role: "merger" },
        `Pushed this issue's wiki changes as wiki commit ${pushed.sha.slice(0, SHORT_SHA_LENGTH)} (history: https://github.com/${cfg.repo}/wiki/_history).`,
      );
    }
  } catch (error) {
    comment(
      cfg,
      n,
      { role: "merger" },
      `The wiki changes from this issue were not pushed: ${String(errorMessage(error))}`,
    );
    return false;
  }
  return true;
}

// GitHub closes an issue from "Closes #N" only when the PR merges into the
// default branch. A base like integration leaves it open, so close it here.
function closeIssue(cfg: Config, n: number, pr: number): void {
  if (issueState(cfg, n) !== "open") {
    return;
  }
  gh(
    cfg,
    [
      "issue",
      "close",
      String(n),
      "-R",
      cfg.repo,
      "--reason",
      "completed",
      "--comment",
      `PR #${pr} merged into ${cfg.baseBranch}.`,
    ],
    { allowFail: true },
  );
}

// After a PR merges, by the pipeline or by hand: delete the branch, mark the
// issue done, label both, and remove the worktree (which runs teardown).
function finishMerged(cfg: Config, n: number, pr: number, state: State): void {
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
  writeState(cfg, n, { ...state, stage: "done", lease: null });
  for (const target of [n, pr]) {
    setLabels(cfg, target, [LABELS.merged.name], [LABELS.working.name]);
    clearStopLabels(cfg, target);
  }
  closeClaims(cfg, n, `PR #${pr} merged.`);
  closeIssue(cfg, n, pr);
  if (pushIssueWiki(cfg, n)) {
    removeWorktree(cfg, n);
  }
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

export { closeParent, finishMerged, post, release };
