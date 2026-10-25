// Confirmed own Lands reuse exact pre-Land checks and clearance after
// read-only result confirmation. Any other landed result stops (#185).

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { requirementsHold } from "../../requirements.ts";
import { currentResultObservation } from "../../security-clearance.ts";
import type { CodeLanded, IssueState, Revision } from "../../state.ts";
import type { Binding } from "../../task-result-records.ts";
import { SHORT_SHA } from "../change-task.ts";
import { currentRevision } from "../revision-source.ts";
import { errorStop } from "../writer-session.ts";
import { confirmedLandedResult, NO_POST_LAND_REPAIR } from "./checks.ts";
import { reviewedAndCompleted } from "./completion.ts";
import { logged, toRequirements } from "./returns.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// After this job's own explicit-target Land of `authorized.code` as
// `mergeCommit`: the receipt saved first; then, only while GitHub confirms
// that Land and the inputs are still the authorized ones, read-only
// confirmation of its pre-Land proof, the bound clearance and the
// completion. Anything else stops or goes to requirements with landed truth
// retained. An interrupted job resumes an exact saved own-Land receipt
// through recovery.ts, preserving its original authorization.
async function afterOwnLand(
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
    { ...start, landed: { ...authorized, code: mergeCommit } },
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
  const refused = await confirmedLandedResult(ctx, state, {
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

// The merge job once the code landed before this job (`codeMerged`, which
// GitHub confirmed) and recovery.ts found no exact own-Land receipt: an
// external, manual or historical landing. Its checks and Security did not
// provably clear this exact result before the target moved, so it stops with
// landed truth retained. No post-Land suite, writer or Security runs here.
function afterEarlierLand(state: IssueState, codeMerged: CodeLanded): RoleEnd {
  return errorStop(
    state,
    `PR #${codeMerged.pr} merged as ${short(codeMerged.sha)} without an exact own-merge receipt and premerge check/Security proof; ${NO_POST_LAND_REPAIR}`,
  );
}

export { afterEarlierLand, afterOwnLand };
