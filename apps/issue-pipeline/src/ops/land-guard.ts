// The gates between an authorized revision and what `merge` (and, through
// finish-guard.ts, the finish op) may do to GitHub, decided against a fresh
// current revision (src/revision.ts) and the issue's saved state rather
// than any claim in a request. Each gate is pure: an inconsistent request
// or GitHub answer throws, a revision that moved returns a refusal, and
// undefined lets the op go on.

import { z } from "zod";
import { legacyWikiOf, REVISION } from "../land-provenance.ts";
import { recordedAuthorization } from "../landed-authorization.ts";
import { OpsError } from "../ops-error.ts";
import type { currentRevision } from "../revision.ts";
import { currentResultObservation } from "../security-clearance.ts";
import type { IssueState, Revision } from "../state.ts";
import { sameRevision } from "../state.ts";

type CurrentRevision = ReturnType<typeof currentRevision>;

// A revision a request names: what hardening authorized (state.ts's Revision,
// whose legacy wiki head it keeps).
const REVISION_REQUEST = REVISION.extend({ inputs: z.string().min(1) });

interface LandStale {
  merged: false;
  reason: "stale";
  current: Revision;
}

// A Land goes on only while the code head and trusted inputs are
// still the authorized `revision` (recordedAuthorization).
function landStale(
  revision: Revision,
  current: CurrentRevision,
): LandStale | undefined {
  if (sameRevision(revision, current.revision)) {
    return undefined;
  }
  return { merged: false, reason: "stale", current: current.revision };
}

// The issue's PR as the current revision reports it, which must be the
// state's PR, merged with a merge commit that agrees with codeMerged.
function mergedPr(
  state: IssueState,
  current: CurrentRevision,
): { mergeCommit: string; headSha: string } | "open" {
  const { pr } = current;
  if (pr === null || pr.number !== state.pr) {
    throw new OpsError(
      `#${state.number}'s PR #${String(state.pr)} is missing from the current revision`,
    );
  }
  if (pr.state !== "MERGED") {
    return "open";
  }
  if (pr.mergeCommit === null || pr.mergeCommit === "") {
    throw new OpsError(`PR #${pr.number} is MERGED with no merge commit`);
  }
  const { codeMerged } = state;
  if (
    codeMerged !== null &&
    (codeMerged.pr !== pr.number || codeMerged.sha !== pr.mergeCommit)
  ) {
    throw new OpsError(
      `the state's codeMerged ${codeMerged.sha} of PR #${codeMerged.pr} is not PR #${pr.number}'s merge commit ${pr.mergeCommit}`,
    );
  }
  return { mergeCommit: pr.mergeCommit, headSha: pr.headSha };
}

// Whether the saved authorization permits GitHub's merged result. An own
// Land keeps the original head authorization and needs its exact saved
// receipt, even after a claim records codeMerged. Independently hardened
// post-Land work instead authorizes the merge commit with codeMerged.
// A done replay always needs the exact saved completion as well. Callers
// first confirm the PR and codeMerged against GitHub through mergedPr.
function landedAuthorizationHolds(
  saved: IssueState,
  result: Revision,
  merged: { mergeCommit: string; headSha: string },
): boolean {
  const authorized = recordedAuthorization(saved);
  if (
    authorized === null ||
    result.code !== merged.mergeCommit ||
    legacyWikiOf(authorized) !== legacyWikiOf(result) ||
    authorized.inputs !== result.inputs ||
    (authorized.policy ?? null) !== (result.policy ?? null)
  ) {
    return false;
  }
  const hasReceipt =
    (saved.stage === "merge" || saved.stage === "done") &&
    saved.merged !== null &&
    sameRevision(saved.merged, result);
  if (authorized.code === merged.headSha) {
    return hasReceipt;
  }
  return (
    saved.codeMerged !== null &&
    authorized.code === merged.mergeCommit &&
    (saved.stage !== "done" || hasReceipt)
  );
}

// A current-policy observation is not historical authorization. It needs both
// the untouched original authorization/receipt and canonical exact landed truth.
function ownLandResultObservation(
  saved: IssueState,
  current: {
    revision: Revision;
    pr: {
      number: number;
      state: string;
      mergeCommit: string | null;
      headSha: string;
    } | null;
  },
): Revision | null {
  const { merged, codeMerged } = saved;
  const { pr } = current;
  if (
    merged === null ||
    pr === null ||
    pr.number !== saved.pr ||
    pr.state !== "MERGED" ||
    pr.mergeCommit === null ||
    recordedAuthorization(saved)?.code !== pr.headSha
  ) {
    return null;
  }
  if (
    codeMerged !== null &&
    (codeMerged.pr !== pr.number || codeMerged.sha !== pr.mergeCommit)
  ) {
    return null;
  }
  if (
    !landedAuthorizationHolds(saved, merged, {
      headSha: pr.headSha,
      mergeCommit: pr.mergeCommit,
    })
  ) {
    return null;
  }
  return currentResultObservation(merged, current.revision);
}

export type { CurrentRevision, LandStale };
export {
  landedAuthorizationHolds,
  landStale,
  mergedPr,
  ownLandResultObservation,
  REVISION_REQUEST,
};
