// How each result's reply changes the reviewer's `data` as the machine
// (machine.ts) takes an edge: the prepared head and what the lenses read,
// a failure's detail, the lenses' outcomes, a clean review's record, the
// blocking findings for the aggregator, the aggregator's reply, and the
// numbered findings. Pure.

import { noteEvent } from "../../workflow/event-log.ts";
import { isRecord, patchIdIn } from "../../workflow/stages/reply-guards.ts";
import { rawFindingsOf } from "../../workflow/stages/review-replies.ts";
import { sessionsReplyOf } from "../sessions.ts";
import type { ReviewerData } from "./locate.ts";
import { findingsOf } from "./locate.ts";

const NO_FINDINGS_NOTE =
  "review: no blocking findings; checks run without a rebase";

// `data` with `text` added to its event log at the run's time.
function noted(data: ReviewerData, text: string): ReviewerData {
  const st = { log: data.log ?? [] };
  noteEvent(st, text, data.context.now);
  return { ...data, log: st.log };
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

// The prepared head: the review starts afresh on it, over the bundle the op
// wrote, or the diff an op before #415 wrote.
function prepared(data: ReviewerData, reply: unknown): ReviewerData {
  if (!isRecord(reply)) {
    return data;
  }
  const { headSha, bundlePath, bundleLines, bundleText } = reply;
  const { diffPath, diffLines } = reply;
  let review: ReviewerData["review"] = {
    path: String(diffPath),
    lines: String(diffLines),
  };
  if (typeof bundlePath === "string" && typeof bundleText === "string") {
    review = { bundlePath, bundleLines: Number(bundleLines), bundleText };
  }
  return {
    ...data,
    headSha: textOf(headSha),
    patchId: patchIdIn(reply),
    review,
    findings: [],
    round: 0,
  };
}

// A failure's text, the stop's detail.
function failed(data: ReviewerData, reply: unknown): ReviewerData {
  return { ...data, failure: String(reply) };
}

// Each lens session's outcome.
function lensesReplied(data: ReviewerData, reply: unknown): ReviewerData {
  return { ...data, lensReplies: sessionsReplyOf(reply) };
}

// A clean review: the head and patch id it passed, so a clean rebase keeps
// it (`review-keeps-on-clean-rebase`).
function cleaned(data: ReviewerData): ReviewerData {
  const reviewed: ReviewerData = {
    ...data,
    reviewedSha: data.headSha ?? null,
    reviewedPatchId: data.patchId,
    testsOnly: false,
  };
  return noted(reviewed, NO_FINDINGS_NOTE);
}

// Blocking findings: the head reviewed, and the findings with their lens for
// the aggregator, or for its fallback.
function blocked(data: ReviewerData, reply: unknown): ReviewerData {
  return {
    ...data,
    reviewedSha: data.headSha ?? null,
    raw: rawFindingsOf(reply),
  };
}

// The aggregator's reply; its failure leaves none, so the raw findings stand.
function aggregated(data: ReviewerData, reply: unknown): ReviewerData {
  return { ...data, merged: reply };
}

function aggregateFailed(data: ReviewerData): ReviewerData {
  return { ...data, merged: null };
}

// The numbered findings, added to the open ones, and the next number.
function stored(data: ReviewerData, reply: unknown): ReviewerData {
  if (!isRecord(reply)) {
    return data;
  }
  const { findings, nextFindingId } = reply;
  const added = findingsOf(findings);
  let next = data.nextFindingId;
  if (typeof nextFindingId === "number") {
    next = nextFindingId;
  }
  const kept = { ...data, findings: [...data.findings, ...added] };
  return noted(
    { ...kept, nextFindingId: next },
    `review: ${added.length} blocking finding(s)`,
  );
}

export {
  aggregated,
  aggregateFailed,
  blocked,
  cleaned,
  failed,
  lensesReplied,
  prepared,
  stored,
};
