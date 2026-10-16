// The review rounds' replies, read from their structured output: the first
// reviewers (REVIEW_SCHEMA), the aggregator (AGG_SCHEMA), the fixer
// (FIX_SCHEMA) and the re-reviewers (REREVIEW_SCHEMA), and the raw findings
// the review carries to its aggregate step. Checked by hand rather than with
// zod: this module runs in the pi-subagents sandbox, which rejects the async
// functions any zod bundle contains (#178). Each reader returns the output's
// own objects, so their keys keep the reviewer's order.

import type { ReportedFinding } from "../types.ts";

// A finding as a first reviewer reports it.
interface ReviewFinding extends ReportedFinding {
  severity: string;
}

// A blocking finding with the lens that raised it, as the aggregator reads it.
interface RawFinding extends ReviewFinding {
  lens: string;
}

// A finding as the aggregator merges it, with every lens that raised it.
interface MergedFinding extends ReportedFinding {
  lenses: string[];
}

interface Dispute {
  id: string;
  evidence: string;
}

// A fixer's reply: `handoff` means it ran out of room before finishing.
interface FixReply {
  status: "done" | "handoff";
  fixed: string[];
  disputed: Dispute[];
  summary: string;
}

interface Verdict {
  id: string;
  status: string;
  note: string;
}

// A finding a re-reviewer says the fix introduced, or brought back when
// `recursId` names a finding resolved earlier.
interface NewFinding extends ReportedFinding {
  recursId: string;
}

interface RereviewReply {
  results: Verdict[];
  newFindings: NewFinding[];
}

type Check<T> = (value: unknown) => value is T;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isListOf<T>(value: unknown, check: Check<T>): value is T[] {
  return Array.isArray(value) && value.every(check);
}

function isCategory(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isReported(value: unknown): value is ReportedFinding {
  if (!isRecord(value)) {
    return false;
  }
  const { file, line, title, evidence, suggestion, category } = value;
  return (
    isString(file) &&
    typeof line === "number" &&
    isString(title) &&
    isString(evidence) &&
    isString(suggestion) &&
    isCategory(category)
  );
}

// Whether `value` is a record whose field, read by `pick`, passes `check`.
function hasField(
  value: unknown,
  pick: (record: Readonly<Record<string, unknown>>) => unknown,
  check: (field: unknown) => boolean,
): boolean {
  return isRecord(value) && check(pick(value));
}

function isReviewFinding(value: unknown): value is ReviewFinding {
  return (
    isReported(value) && hasField(value, ({ severity }) => severity, isString)
  );
}

function isRawFinding(value: unknown): value is RawFinding {
  return (
    isReviewFinding(value) && hasField(value, ({ lens }) => lens, isString)
  );
}

function isStrings(value: unknown): value is string[] {
  return isListOf(value, isString);
}

function isMerged(value: unknown): value is MergedFinding {
  return (
    isReported(value) && hasField(value, ({ lenses }) => lenses, isStrings)
  );
}

function isDispute(value: unknown): value is Dispute {
  if (!isRecord(value)) {
    return false;
  }
  const { id, evidence } = value;
  return isString(id) && isString(evidence);
}

function isVerdict(value: unknown): value is Verdict {
  if (!isRecord(value)) {
    return false;
  }
  const { id, status, note } = value;
  return isString(id) && isString(status) && isString(note);
}

function isNewFinding(value: unknown): value is NewFinding {
  return (
    isReported(value) && hasField(value, ({ recursId }) => recursId, isString)
  );
}

// A first reviewer's findings, or null when the output doesn't fit the schema.
function reviewFindingsOf(output: unknown): ReviewFinding[] | null {
  if (!isRecord(output)) {
    return null;
  }
  const { findings } = output;
  if (!isListOf(findings, isReviewFinding)) {
    return null;
  }
  return findings;
}

// The aggregator's merged findings, or null when the output doesn't fit.
function mergedFindingsOf(output: unknown): MergedFinding[] | null {
  if (!isRecord(output)) {
    return null;
  }
  const { blocking } = output;
  if (!isListOf(blocking, isMerged)) {
    return null;
  }
  return blocking;
}

function fixReplyOf(output: unknown): FixReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { status, fixed, disputed, summary } = output;
  if (
    !(
      (status === "done" || status === "handoff") &&
      isListOf(fixed, isString) &&
      isListOf(disputed, isDispute) &&
      isString(summary)
    )
  ) {
    return null;
  }
  return { status, fixed, disputed, summary };
}

function rereviewReplyOf(output: unknown): RereviewReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { results, newFindings } = output;
  if (!(isListOf(results, isVerdict) && isListOf(newFindings, isNewFinding))) {
    return null;
  }
  return { results, newFindings };
}

// The raw findings the review carried to its aggregate step. Anything else is
// a bug in the review's own steps.
function rawFindingsOf(carry: unknown): RawFinding[] {
  if (!isListOf(carry, isRawFinding)) {
    throw new Error("review: expected the raw findings in the carry");
  }
  return carry;
}

export type {
  Dispute,
  FixReply,
  MergedFinding,
  NewFinding,
  RawFinding,
  RereviewReply,
  ReviewFinding,
  Verdict,
};
export {
  fixReplyOf,
  mergedFindingsOf,
  rawFindingsOf,
  rereviewReplyOf,
  reviewFindingsOf,
};
