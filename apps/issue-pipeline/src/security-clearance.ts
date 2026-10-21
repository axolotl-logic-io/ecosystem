// Whether an issue's saved security review clears a merged result for
// publication and completion: it must have found nothing at exactly that
// result. No review, a finding, or a review of any other revision clears
// nothing, so a merge into the base never completes an issue on its own.

import type { IssueState, Revision } from "./state.ts";
import { sameRevision } from "./state.ts";

// Why `saved`'s security review doesn't clear `result` (GitHub's merge
// commit, or null with no PR; the trusted inputs), or
// undefined when it does. Only the issue's saved state counts.
function securityRefusal(
  saved: IssueState | null,
  result: Revision,
): string | undefined {
  const security = saved?.security ?? null;
  if (security === null || !sameRevision(security.revision, result)) {
    return `no security review of the merged result (code ${String(result.code)}, inputs ${result.inputs}) is saved`;
  }
  const { finding } = security;
  if (finding !== null) {
    return `the security review stopped the merged result (${finding.category}): ${finding.reason}`;
  }
  return undefined;
}

export { securityRefusal };
