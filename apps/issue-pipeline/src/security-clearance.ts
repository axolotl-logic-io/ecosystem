// Whether an issue's saved security review clears a merged result for
// publication and completion: it must have found nothing at exactly that
// result. No review, a finding, or a review of any other revision clears
// nothing, so a merge into the base never completes an issue on its own.

import { legacyWikiOf } from "./merge-provenance.ts";
import type { IssueState, Revision } from "./state.ts";
import { sameRevision } from "./state.ts";

// Policy changes are not remediation of a finding on unchanged work. This
// subject comparison never grants clearance or premerge authorization.
function sameSecuritySubject(a: Revision, b: Revision): boolean {
  return (
    a.code === b.code &&
    a.inputs === b.inputs &&
    legacyWikiOf(a) === legacyWikiOf(b)
  );
}

// Only callers that independently confirm an original own-merge receipt may
// reobserve that result under today's policy. The historical receipt stays intact.
function currentResultObservation(
  receipt: Revision,
  current: Revision,
): Revision | null {
  if (!sameSecuritySubject(receipt, current)) {
    return null;
  }
  if (current.policy === undefined) {
    if (receipt.policy !== undefined) {
      return null;
    }
    return receipt;
  }
  return { ...receipt, policy: current.policy };
}

// Why `saved`'s security review doesn't clear `result` (GitHub's merge
// commit, or null with no PR; the trusted inputs), or
// undefined when it does. Only the issue's saved state counts.
function securityRefusal(
  saved: IssueState | null,
  result: Revision,
): string | undefined {
  const security = saved?.security ?? null;
  if (
    security !== null &&
    security.finding !== null &&
    sameSecuritySubject(security.revision, result)
  ) {
    return `the security review stopped the merged result (${security.finding.category}): ${security.finding.reason}`;
  }
  if (security === null || !sameRevision(security.revision, result)) {
    return `no security review of the merged result (code ${String(result.code)}, inputs ${result.inputs}) is saved`;
  }
  return undefined;
}

export { currentResultObservation, sameSecuritySubject, securityRefusal };
