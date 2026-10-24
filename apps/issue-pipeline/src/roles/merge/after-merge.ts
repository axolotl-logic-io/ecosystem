// Confirmed own merges reuse exact premerge checks and clearance after
// read-only result confirmation. Any other merged result stops (#185).

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { requirementsHold } from "../../requirements.ts";
import { currentResultObservation } from "../../security-clearance.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import type { Binding } from "../../task-result-records.ts";
import { SHORT_SHA } from "../change-task.ts";
import { currentRevision } from "../revision-source.ts";
import { errorStop } from "../writer-session.ts";
import { confirmedMergedResult, NO_POSTMERGE_REPAIR } from "./checks.ts";
import { reviewedAndCompleted } from "./completion.ts";
import { logged, toRequirements } from "./returns.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// After this job's own explicit-target merge of `authorized.code` as
// `mergeCommit`: the receipt saved first; then, only while GitHub confirms
// that merge and the inputs are still the authorized ones, read-only
// confirmation of its premerge proof, the bound clearance and the
// completion. Anything else stops or goes to requirements with merged truth
// retained. An interrupted job resumes an exact saved own-merge receipt
// through recovery.ts, preserving its original authorization.
async function afterOwnMerge(
  ctx: RoleContext,
  start: IssueState,
  {
    authorized,
    mergeCommit,
    land = null,
  }: { authorized: Revision; mergeCommit: string; land?: Binding | null },
): Promise<RoleEnd> {
  const merged = `PR #${start.pr} merged as ${short(mergeCommit)}`;
  const state = logged(
    { ...start, merged: { ...authorized, code: mergeCommit } },
    `merged PR #${start.pr} at ${authorized.code} as ${mergeCommit}`,
  );
  await ctx.save(state);
  const fresh = await currentRevision(ctx);
  const { gherkin } = ctx.inputs;
  const { revision, pr } = fresh;
  if (
    revision.inputs !== authorized.inputs ||
    !requirementsHold(state, gherkin, revision.inputs)
  ) {
    return toRequirements(state, `${merged}, then the trusted inputs changed`);
  }
  const receipt: Revision = { ...authorized, code: mergeCommit };
  const result = currentResultObservation(receipt, revision);
  const receiptHolds =
    pr !== null &&
    pr.number === start.pr &&
    pr.state === "MERGED" &&
    pr.headSha === authorized.code &&
    pr.mergeCommit === mergeCommit;
  if (start.pr === null || result === null || !receiptHolds) {
    return errorStop(
      state,
      `${merged}, but GitHub no longer matches it; merged truth is retained`,
    );
  }
  const codeMerged = { pr: start.pr, sha: mergeCommit };
  const refused = await confirmedMergedResult(ctx, state, {
    result,
    codeMerged,
    landed: land,
  });
  if (refused !== null) {
    return refused;
  }
  return await reviewedAndCompleted(ctx, state, {
    merged: receipt,
    result,
  });
}

// The merge job once the code merged before this job (`codeMerged`, which
// GitHub confirmed) and recovery.ts found no exact own-merge receipt: an
// external, manual or historical merge. Its checks and Security did not
// provably clear this exact result before the target moved, so it stops with
// merged truth retained. No postmerge suite, writer or Security runs here.
function afterEarlierMerge(state: IssueState, codeMerged: CodeMerged): RoleEnd {
  return errorStop(
    state,
    `PR #${codeMerged.pr} merged as ${short(codeMerged.sha)} without an exact own-merge receipt and premerge check/Security proof; ${NO_POSTMERGE_REPAIR}`,
  );
}

export { afterEarlierMerge, afterOwnMerge };
