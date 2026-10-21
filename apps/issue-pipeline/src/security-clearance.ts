// Candidate clearance is distinct from historical postmerge review. Missing
// provenance cannot turn an old receipt into permission for a new merge.
import { recordedAuthorization } from "./merged-authorization.ts";
import type { IssueState, Revision, Security } from "./state.ts";
import { approvalHolds, sameRevision } from "./state.ts";

type Candidate = NonNullable<Security["candidate"]>;

function candidateRefusal(
  saved: IssueState,
  revision: Revision,
  candidate: Candidate,
): string | undefined {
  const { security } = saved;
  if (
    !approvalHolds(saved, revision) ||
    saved.verifiedSha !== revision.code ||
    security?.candidate === undefined ||
    security.candidate.target !== candidate.target ||
    security.candidate.baseSha !== candidate.baseSha ||
    !sameRevision(security.revision, revision)
  ) {
    return "no exact hardened, checked and Security-cleared candidate is saved for this target revision";
  }
  return findingRefusal(security);
}

function findingRefusal(security: Security): string | undefined {
  if (security.finding !== null) {
    const { category, reason } = security.finding;
    return `the security review stopped this revision (${category}): ${reason}`;
  }
  return undefined;
}

// Completion follows genuine result confirmation and deterministic checks.
// An explicitly premerge receipt is reusable only for the retained own merge's
// original exact authorization. Old receipts clear only their merged revision.
function securityRefusal(
  saved: IssueState | null,
  result: Revision,
): string | undefined {
  const security = saved?.security;
  if (security === null || security === undefined) {
    return "no security review is saved";
  }
  if (security.candidate !== undefined) {
    let authorized: Revision | null = null;
    if (saved !== null) {
      authorized = recordedAuthorization(saved);
    }
    if (
      saved?.merged === null ||
      saved?.merged === undefined ||
      !sameRevision(saved.merged, result) ||
      authorized === null ||
      !sameRevision(security.revision, authorized) ||
      authorized.inputs !== result.inputs
    ) {
      return "candidate Security clearance is not bound to this own merged result";
    }
  } else if (!sameRevision(security.revision, result)) {
    return `no security review of the merged result (code ${String(result.code)}, inputs ${result.inputs}) is saved`;
  }
  return findingRefusal(security);
}

export type { Candidate };
export { candidateRefusal, securityRefusal };
