// Where a reviewer run starts, and what it carries (`every-role-resumes` in
// the wiki's Pipeline-Roles-Shared page; Pipeline-Roles-Reviewer, "Locate").
// Every start at `review`, a state saved by the old `review` stage included,
// claims the issue and runs the entry again: the lenses are read-only, their
// comments are keyed, and the findings are numbered on from the saved
// `nextFindingId`. It reads back the hand-off fields the role writes, so a
// save keeps what the run didn't change, such as `reviewedSha` and
// `reviewedPatchId` (`review-keeps-on-clean-rebase`). Pure.

import type { State } from "../../state.ts";
import { isRecord, isStrings } from "../../workflow/stages/reply-guards.ts";
import type { ReviewBundle } from "../../workflow/stages/review-prefix.ts";
import type { RawFinding } from "../../workflow/stages/review-replies.ts";
import type { ReviewDiff } from "../../workflow/stages/review-text.ts";
import type { Finding } from "../../workflow/types.ts";
import type { MachineState } from "../machine.ts";
import type { SessionsReply } from "../sessions.ts";
import type { RoleContext } from "../walk.ts";

// The machine's states: the prelude, the `review` entry's states (the wiki's
// "Entry `review`" table), then its ends.
type ReviewerState =
  | "claim"
  | "checkout"
  | "prepare"
  | "lenses"
  | "post-lenses"
  | "aggregate"
  | "store-findings"
  | "released"
  | "prep-failed"
  | "nothing-to-review"
  | "lens-failed"
  | "clean"
  | "findings-stored";

// What the run hands to the next role, as the old `review` stage saved it:
// the head reviewed, the numbered findings and the next number, the fix
// rounds run, the head the review saw and, for a clean review, its changes'
// patch id, whether only the tests run again, and the event log.
interface ReviewerHandoff {
  headSha: string | null | undefined;
  findings: Finding[];
  nextFindingId: number | undefined;
  round: number | undefined;
  reviewedSha: string | null | undefined;
  reviewedPatchId: string | null | undefined;
  testsOnly: boolean | undefined;
  log: string[] | undefined;
}

interface ReviewerData extends ReviewerHandoff {
  issue: number;
  // The PR the lens and findings comments go on, or null for none.
  pr: number | null;
  // What the sessions' tasks are built from.
  context: RoleContext;
  // The issue's spec, which the tasks show.
  spec: { spec: string | null; specFile: string | null };
  // The prepared head's patch id, from prepare-review's reply.
  patchId: string | null;
  // What the lenses read: the bundle, or the diff an op before #415 wrote.
  review: ReviewBundle | ReviewDiff | null;
  // Each lens session's outcome, once the lenses replied.
  lensReplies: SessionsReply | null;
  // The lenses' blocking findings, with their lens, for the aggregator.
  raw: RawFinding[];
  // The aggregator's reply, or null when it failed or hasn't run.
  merged: unknown;
  // The stop's detail: the first failed lens, or the failed prep.
  failure: string | null;
}

function textOr<T>(value: unknown, fallback: T): string | T {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

// A saved text that may be null: a malformed one reads as missing.
function nullableText(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return textOr(value, undefined);
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

// A saved finding as the workflow numbered it.
function isFinding(value: unknown): value is Finding {
  if (!isRecord(value)) {
    return false;
  }
  const { id, file, line, title, lenses, status, disputed } = value;
  return (
    typeof id === "string" &&
    typeof file === "string" &&
    typeof line === "number" &&
    typeof title === "string" &&
    isStrings(lenses) &&
    (status === "open" || status === "resolved") &&
    typeof disputed === "boolean"
  );
}

// The well-formed findings in `saved`, a list or nothing.
function findingsOf(saved: unknown): Finding[] {
  const kept: Finding[] = [];
  if (!Array.isArray(saved)) {
    return kept;
  }
  for (const entry of saved) {
    if (isFinding(entry)) {
      kept.push(entry);
    }
  }
  return kept;
}

// The saved hand-off fields; a malformed one reads as missing.
function handoffOf(saved: State): ReviewerHandoff {
  const { headSha, findings, nextFindingId, round, log } = saved;
  const { reviewedSha, reviewedPatchId, testsOnly } = saved;
  let kept: boolean | undefined;
  if (typeof testsOnly === "boolean") {
    kept = testsOnly;
  }
  return {
    headSha: nullableText(headSha),
    findings: findingsOf(findings),
    nextFindingId: numberOr(nextFindingId),
    round: numberOr(round),
    reviewedSha: nullableText(reviewedSha),
    reviewedPatchId: nullableText(reviewedPatchId),
    testsOnly: kept,
    log: (log ?? []).filter((line) => typeof line === "string"),
  };
}

function locate(
  saved: State,
  context: RoleContext,
): MachineState<ReviewerState, ReviewerData> {
  const { pr, spec, specFile } = saved;
  let prNumber: number | null = null;
  if (typeof pr === "number" && pr !== 0) {
    prNumber = pr;
  }
  const data: ReviewerData = {
    ...handoffOf(saved),
    issue: context.issue,
    pr: prNumber,
    context,
    spec: { spec: textOr(spec, null), specFile: textOr(specFile, null) },
    patchId: null,
    review: null,
    lensReplies: null,
    raw: [],
    merged: null,
    failure: null,
  };
  return { at: "claim", data };
}

export type { ReviewerData, ReviewerHandoff, ReviewerState };
export { findingsOf, locate };
