// The gate on the finish op: the saved completion it may close an issue on,
// decided against a fresh current revision (src/revision.ts) and the
// issue's saved state. Like merge-guard.ts's gates it is pure: an
// inconsistent saved state or GitHub answer throws, a revision that moved
// or a security review that doesn't clear the merged result refuses, and
// undefined lets the op go on.

import { recordedAuthorization } from "../merged-authorization.ts";
import { OpsError } from "../ops-error.ts";
import { securityRefusal } from "../security-clearance.ts";
import type { IssueState, Revision } from "../state.ts";
import type { CurrentRevision } from "./merge-guard.ts";
import { mergedAuthorizationHolds, mergedPr } from "./merge-guard.ts";

interface FinishRefusal {
  finished: false;
  reason: "inputs-changed" | "security";
  detail: string;
}

// Throws unless the saved completion binds the authorized inputs (and any
// legacy wiki head) to GitHub's exact merge: either the original authorized
// head with its own-merge receipt, or independently hardened postmerge work
// with confirmed codeMerged. Recording codeMerged never changes which path
// authorized it.
function unauthorizedHead(
  saved: IssueState,
  merged: Revision,
  pr: { mergeCommit: string; headSha: string },
): void {
  if (!mergedAuthorizationHolds(saved, merged, pr)) {
    const authorized = recordedAuthorization(saved)?.code ?? null;
    throw new OpsError(
      `#${saved.number}'s merge authorization ${String(authorized)} is not bound to the saved result of head ${pr.headSha} as ${pr.mergeCommit}, which PR #${String(saved.pr)} merged`,
    );
  }
}

// The saved completion the finish op may act on: done, with the merged
// revision, its PR (if any) merged at merged.code from the authorized head
// (a change with no PR merged no code), the trusted inputs unchanged since, and the saved
// security review clear at exactly that merged revision. A state that isn't
// such a completion throws; new trusted input refuses, so the issue stays
// open for the author, and so does a security review that didn't clear it.
function finishGate(
  saved: IssueState,
  current: CurrentRevision,
): FinishRefusal | undefined {
  const { merged } = saved;
  if (saved.stage !== "done" || merged === null) {
    throw new OpsError(
      `the finish op needs #${saved.number}'s saved state done with a merged revision; it is ${saved.stage}`,
    );
  }
  if (saved.pr === null) {
    if (saved.flows?.code === true || merged.code !== null) {
      throw new OpsError(
        `#${saved.number} is done with code ${String(merged.code)} but no PR`,
      );
    }
  } else {
    const pr = mergedPr(saved, current);
    if (pr === "open" || pr.mergeCommit !== merged.code) {
      throw new OpsError(
        `#${saved.number} is saved merged at ${String(merged.code)}, which is not PR #${saved.pr}'s merge commit`,
      );
    }
    unauthorizedHead(saved, merged, pr);
  }
  if (current.revision.inputs !== merged.inputs) {
    return {
      finished: false,
      reason: "inputs-changed",
      detail: `the trusted inputs changed since the merge (${current.revision.inputs})`,
    };
  }
  const uncleared = securityRefusal(saved, merged);
  if (uncleared !== undefined) {
    return { finished: false, reason: "security", detail: uncleared };
  }
  return undefined;
}

export type { FinishRefusal };
export { finishGate };
