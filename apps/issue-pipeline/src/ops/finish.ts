// What happens once an issue leaves the pipeline or ends a job: completing
// an issue after its merge role saved it done and merged (finish-wiki),
// and closing a parent whose sub-issues are all closed.

import { z } from "zod";
import { assignedBranch } from "../branch-binding.ts";
import { removeWorktree } from "../checkouts.ts";
import { closeClaims } from "../claims.ts";
import { comment, signed } from "../comments.ts";
import type { Config } from "../config.ts";
import { gh, ghJson, issueState } from "../github.ts";
import { clearStopLabels, LABELS, setLabels } from "../labels.ts";
import { OpsError } from "../ops-error.ts";
import { parseRequest } from "../process.ts";
import { currentRevision } from "../revision.ts";
import { readState } from "../saved-state.ts";
import type { IssueState, Revision } from "../state.ts";
import { ISSUE_STATE } from "../state.ts";
import { confirmWikiPublished } from "../wiki-publication.ts";
import type { FinishRefusal } from "./finish-guard.ts";
import { finishGate } from "./finish-guard.ts";

const SUB_ISSUES_PER_PAGE = 100;
const SHORT_SHA_LENGTH = 12;

// The sub-issues as closeParent's jq reads them (GitHub's `state_reason` as
// `reason`, each label by name), or null when gh printed nothing.
const SUB_ISSUES = z
  .array(
    z.looseObject({
      number: z.number(),
      state: z.unknown(),
      reason: z.string().nullable(),
      labels: z.array(z.string()),
    }),
  )
  .nullable();

type SubIssue = NonNullable<z.infer<typeof SUB_ISSUES>>[number];

const ISSUE_REQUEST = z.looseObject({ number: z.number().int() });
// finish-wiki acts on the saved state; a `state` sent along must agree with
// it, so a role can't finish a completion it never saved.
const FINISH_WIKI_REQUEST = z.looseObject({
  number: z.number().int(),
  state: ISSUE_STATE.optional(),
});

type CloseParentReply =
  | { closed: false; reason: string }
  | { closed: false; open: number[] }
  | { closed: true };

// `closed` is false when the issue was already closed, as on a retry.
type FinishWikiReply = { finished: true; closed: boolean } | FinishRefusal;

function short(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

// Deletes the code branch `state` binds the issue to on GitHub, if it is
// there.
function deleteBranch(cfg: Config, state: IssueState): void {
  const n = state.number;
  gh(
    cfg,
    "merge",
    [
      "api",
      "-X",
      "DELETE",
      `repos/${cfg.repo}/git/refs/heads/${assignedBranch(cfg, n, state)}`,
      "--silent",
    ],
    { allowFail: true },
  );
}

// GitHub closes an issue from "Closes #N" only when the PR merges into the
// default branch. A base like integration leaves it open, so close it here,
// with `text` as the closing comment. True when this call closed it; an
// unreadable issue or a failed close throws, so the completion is retried.
function closeIssue(cfg: Config, n: number, text: string): boolean {
  const state = issueState(cfg, n);
  if (state === null) {
    throw new OpsError(`could not read whether #${n} is open`);
  }
  if (state !== "open") {
    return false;
  }
  gh(cfg, "merge", [
    "issue",
    "close",
    String(n),
    "-R",
    cfg.repo,
    "--reason",
    "completed",
    "--comment",
    text,
  ]);
  return true;
}

// The closing comment for the merged revision.
function closingText(cfg: Config, state: IssueState, merged: Revision): string {
  const lines: string[] = [];
  if (state.pr !== null && merged.code !== null) {
    lines.push(
      `PR #${state.pr} merged into ${cfg.baseBranch} as ${short(merged.code)}.`,
    );
  } else if (merged.wiki !== null) {
    lines.push(
      "This issue's change lives only in the wiki, so it had no PR to merge.",
    );
  }
  if (merged.wiki !== null) {
    lines.push(
      `Published wiki commit ${short(merged.wiki)} (history: https://github.com/${cfg.repo}/wiki/_history).`,
    );
  }
  if (lines.length === 0) {
    lines.push("The approved revision has no code or wiki change to merge.");
  }
  return signed({ role: "merger" }, lines.join(" "));
}

function sameMerged(a: Revision | null, b: Revision | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.code === b.code &&
    a.wiki === b.wiki &&
    a.inputs === b.inputs
  );
}

// The completion cleanup, every step safe to repeat: the code branch, the
// labels and the claims, then the issue, then the worktree (in a stage job,
// only the teardown: the job removes its own checkout as it exits). A crash before
// the close leaves the issue open, done and merged, which the orchestrator
// schedules again, with the checkout that proves the wiki publication still
// there.
function complete(cfg: Config, state: IssueState, merged: Revision): boolean {
  const n = state.number;
  deleteBranch(cfg, state);
  if (state.pr !== null) {
    setLabels(cfg, state.pr, [LABELS.merged.name], [LABELS.working.name]);
    clearStopLabels(cfg, state.pr);
  }
  setLabels(cfg, n, [LABELS.merged.name], [LABELS.working.name]);
  clearStopLabels(cfg, n);
  let why = "Change published.";
  if (state.pr !== null) {
    why = `PR #${state.pr} merged.`;
  }
  closeClaims(cfg, n, why);
  const closed = closeIssue(cfg, n, closingText(cfg, state, merged));
  removeWorktree(cfg, n);
  return closed;
}

// Completes an issue whose merge role saved it done with the merged revision
// (code merged and wiki published): only after a fresh check that the PR
// merged at merged.code, the wiki holds merged.wiki and the trusted inputs
// are unchanged. It publishes and merges nothing itself. Safe to repeat, so
// a crash between the save and the cleanup is finished by running it again.
function finishWiki(cfg: Config, request: unknown): FinishWikiReply {
  const req = parseRequest(FINISH_WIKI_REQUEST, "finish-wiki", request);
  const n = req.number;
  const saved = readState(cfg, n).state;
  if (saved === null) {
    throw new OpsError(`#${n} has no readable saved state to finish`);
  }
  if (req.state !== undefined && !sameMerged(req.state.merged, saved.merged)) {
    throw new OpsError(
      `finish-wiki's state for #${n} is not the saved completion`,
    );
  }
  const refused = finishGate(saved, currentRevision(cfg, n, saved));
  if (refused !== undefined) {
    return refused;
  }
  const { merged } = saved;
  if (merged === null) {
    throw new OpsError(`#${n} has no merged revision`);
  }
  if (merged.wiki !== null) {
    const proof = confirmWikiPublished(cfg, n, merged.wiki);
    if (!proof.published) {
      return { finished: false, reason: proof.reason, detail: proof.detail };
    }
  }
  return { finished: true, closed: complete(cfg, saved, merged) };
}

// A closed sub-issue merged when GitHub closed it as completed, as a merge
// does, or it carries agent:merged.
function subIssueMerged(sub: SubIssue): boolean {
  return sub.reason === "completed" || sub.labels.includes(LABELS.merged.name);
}

// Closes a split issue once every sub-issue is closed and at least one of
// them merged; otherwise it writes nothing. It closes the issue before it
// relabels it and comments, so a close that fails leaves no comment and a
// retry comments once.
function closeParent(cfg: Config, request: unknown): CloseParentReply {
  const { number: n } = parseRequest(ISSUE_REQUEST, "close-parent", request);
  const subs =
    SUB_ISSUES.parse(
      ghJson(cfg, "merge", [
        "api",
        `repos/${cfg.repo}/issues/${n}/sub_issues?per_page=${SUB_ISSUES_PER_PAGE}`,
        "--jq",
        "[.[] | {number, state, reason: .state_reason, labels: [.labels[].name]}]",
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
  if (!subs.some(subIssueMerged)) {
    return { closed: false, reason: "no sub-issue merged" };
  }
  gh(cfg, "merge", ["issue", "close", String(n), "-R", cfg.repo]);
  setLabels(cfg, n, [LABELS.merged.name], [LABELS.split.name]);
  const list = subs.map((sub) => `#${sub.number}`).join(", ");
  comment(
    cfg,
    n,
    { role: "coordinator" },
    `All sub-issues are closed (${list}). Closing.`,
  );
  return { closed: true };
}

export type { CloseParentReply, FinishWikiReply };
export { closeParent, finishWiki };
