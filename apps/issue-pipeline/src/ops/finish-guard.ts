// The gate on finish-wiki: the saved completion it may close an issue on,
// decided against a fresh current revision (src/revision.ts) and the
// issue's saved state. Like publication-guard.ts's gates it is pure: an
// inconsistent saved state or GitHub answer throws, a revision that moved
// or a security review that doesn't clear the merged result refuses, and
// undefined lets the op go on.

import { OpsError } from "../process.ts";
import { securityRefusal } from "../security-clearance.ts";
import type { IssueState } from "../state.ts";
import { mergeAuthorization } from "../state.ts";
import type { CurrentRevision } from "./publication-guard.ts";
import { mergedPr } from "./publication-guard.ts";

interface FinishRefusal {
  finished: false;
  reason: "inputs-changed" | "wiki-unpublished" | "wiki-changed" | "security";
  detail: string;
}

// Throws unless the saved merge authorization's code is the head GitHub
// merged (its merge commit, once codeMerged recorded it), checked apart from
// the merge commit itself.
function unauthorizedHead(
  saved: IssueState,
  pr: { mergeCommit: string; headSha: string },
): void {
  let expected = pr.headSha;
  if (saved.codeMerged !== null) {
    expected = pr.mergeCommit;
  }
  const authorized = mergeAuthorization(saved)?.code ?? null;
  if (authorized !== expected) {
    throw new OpsError(
      `#${saved.number}'s merge authorization ${String(authorized)} is not ${expected}, which PR #${String(saved.pr)} merged`,
    );
  }
}

// The saved completion finish-wiki may act on: done, with the merged
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
      `finish-wiki needs #${saved.number}'s saved state done with a merged revision; it is ${saved.stage}`,
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
    unauthorizedHead(saved, pr);
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
