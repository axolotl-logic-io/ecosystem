// Candidate clearance is distinct from historical postmerge review. Missing
// provenance cannot turn an old receipt into permission for a new merge.
import type { Config } from "./config.ts";
import { legacyWikiOf } from "./merge-provenance.ts";
import { recordedAuthorization } from "./merged-authorization.ts";
import { targetHolds } from "./reviewed-target.ts";
import type { IssueState, Revision, Security } from "./state.ts";
import { approvalHolds, sameRevision } from "./state.ts";

// Policy and target changes invalidate clearance, not known harm in unchanged
// code/trusted inputs. Keep this comparison separate from merge authorization.
function sameSecuritySubject(a: Revision, b: Revision): boolean {
  return (
    a.code === b.code &&
    a.inputs === b.inputs &&
    legacyWikiOf(a) === legacyWikiOf(b)
  );
}

function candidateRefusal(
  saved: IssueState,
  revision: Revision,
  cfg: Config,
  sha: string,
): string | undefined {
  const { security } = saved;
  if (
    !approvalHolds(saved, revision) ||
    saved.verifiedSha !== revision.code ||
    !targetHolds(cfg, saved.hardenedTarget, sha) ||
    security?.phase !== "candidate" ||
    !targetHolds(cfg, security.target, sha) ||
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
  if (security.phase === "candidate") {
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
      saved.hardenedTarget === null ||
      security.target.repo !== saved.hardenedTarget.repo ||
      security.target.branch !== saved.hardenedTarget.branch ||
      security.target.sha !== saved.hardenedTarget.sha ||
      authorized.inputs !== result.inputs
    ) {
      return "candidate Security clearance is not bound to this own merged result";
    }
  } else if (!sameRevision(security.revision, result)) {
    return `no security review of the merged result (code ${String(result.code)}, inputs ${result.inputs}) is saved`;
  }
  return findingRefusal(security);
}

export { candidateRefusal, sameSecuritySubject, securityRefusal };
