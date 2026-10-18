// How the `accept` entry's results change the reviewer's `data` (#423; the
// wiki's Pipeline-Roles-Reviewer, "Acceptance"): the final diff's path and
// patch id, a deferral's note, a kept verdict's note, the verifier's reply,
// and a pass or a fail as today's `accept` stage records them. Pure.

import { addFinding } from "../../workflow/findings.ts";
import { acceptanceFinding, keptText } from "../../workflow/stages/accept.ts";
import { acceptReplyOf } from "../../workflow/stages/replies.ts";
import { isRecord, patchIdIn } from "../../workflow/stages/reply-guards.ts";
import type { IssueState } from "../../workflow/types.ts";
import { noted } from "./edges.ts";
import type { ReviewerData } from "./locate.ts";

const DEFERRED_NOTE =
  "deferred: network error during prepare-review; will retry";

// The final diff prepare-review wrote at the verified head, and its
// changes' patch id.
function finalPrepared(data: ReviewerData, reply: unknown): ReviewerData {
  if (!isRecord(reply)) {
    return data;
  }
  const { diffPath } = reply;
  let path: string | null = null;
  if (typeof diffPath === "string") {
    path = diffPath;
  }
  return { ...data, patchId: patchIdIn(reply), diffPath: path };
}

function deferred(data: ReviewerData): ReviewerData {
  return noted(data, DEFERRED_NOTE);
}

// The verdict kept, as the event log notes it.
function keptVerdict(data: ReviewerData): ReviewerData {
  return noted(data, keptText(data.acceptedSha));
}

function verdictReplied(data: ReviewerData, reply: unknown): ReviewerData {
  return { ...data, verdict: reply };
}

// The verdict's reason, noted in the event log with its verdict.
function verdictNoted(
  data: ReviewerData,
  reply: unknown,
): {
  data: ReviewerData;
  reason: string;
} {
  const verdict = acceptReplyOf(reply);
  const reason = verdict?.reason ?? "";
  const text = `acceptance: ${verdict?.verdict ?? "fail"} - ${reason}`;
  return { data: noted(data, text), reason };
}

// A pass: its reason, and the head and patch id it judged.
function passed(data: ReviewerData, reply: unknown): ReviewerData {
  const { data: logged, reason } = verdictNoted(data, reply);
  return {
    ...logged,
    acceptReason: reason,
    acceptedSha: data.verifiedSha,
    acceptedPatchId: data.patchId,
  };
}

// A fail: the unmet requirement as an open acceptance finding, numbered on,
// for the fixer, which reviews from the verified head; the last pass no
// longer stands.
function rejected(data: ReviewerData, reply: unknown): ReviewerData {
  const { data: logged, reason } = verdictNoted(data, reply);
  const st: Pick<IssueState, "findings" | "nextFindingId"> = {
    findings: [...data.findings],
    nextFindingId: data.nextFindingId ?? 0,
  };
  addFinding({ st }, acceptanceFinding(reason), ["acceptance"]);
  return {
    ...logged,
    findings: st.findings,
    nextFindingId: st.nextFindingId,
    reviewedSha: data.verifiedSha ?? data.headSha ?? null,
    acceptedSha: null,
    acceptedPatchId: null,
  };
}

export {
  deferred,
  finalPrepared,
  keptVerdict,
  passed,
  rejected,
  verdictReplied,
};
