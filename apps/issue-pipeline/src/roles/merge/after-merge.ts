// The merge job's way to the security review of the merged result and the
// completion (completion.ts), after its own code merge or one before it.
//
// `state.merged` means two things by stage. At merge it is this job's own
// merge receipt, saved right after the explicit-target code merge and before
// the security review: `merged.code` is the merge commit, `merged.inputs`
// the authorized inputs (with a legacy wiki head, if any), and the
// authorized revision's code (state.ts mergeAuthorization) the pre-merge
// head the merge matched. At done it is the completion: what merged.

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { requirementsHold } from "../../requirements.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { currentRevision } from "../revision-source.ts";
import { errorStop } from "../writer-session.ts";
import { checkedMergedResult, localChecks } from "./checks.ts";
import { reviewedAndCompleted, stillAt } from "./completion.ts";
import { integrate } from "./integration.ts";
import { logged, toRequirements } from "./returns.ts";
import { approvalGate } from "./source.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// After this job's own explicit-target merge of `authorized.code` as
// `mergeCommit`: the receipt saved first; then, only while GitHub confirms
// that merge and the inputs are still the authorized ones, the security
// review of the merged result and the completion. Anything else goes back
// to review. An interrupted job resumes an exact saved own-merge receipt
// through recovery.ts, preserving its original authorization; changed work
// instead needs hardening against the merged code before this module takes
// its earlier-merge path.
async function afterOwnMerge(
  ctx: RoleContext,
  start: IssueState,
  { authorized, mergeCommit }: { authorized: Revision; mergeCommit: string },
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
  const result: Revision = { ...authorized, code: mergeCommit };
  const still = stillAt(result);
  const receiptHolds =
    pr !== null &&
    pr.number === start.pr &&
    pr.state === "MERGED" &&
    pr.headSha === authorized.code &&
    pr.mergeCommit === mergeCommit &&
    still(revision);
  if (start.pr === null || !receiptHolds) {
    return errorStop(
      state,
      `${merged}, but GitHub no longer matches it; merged truth is retained`,
    );
  }
  const codeMerged = { pr: start.pr, sha: mergeCommit };
  const checked = await checkedMergedResult(ctx, state, result, codeMerged);
  if ("end" in checked) {
    return checked.end;
  }
  return await reviewedAndCompleted(ctx, checked.state, {
    merged: result,
    codeMerged,
    still,
  });
}

// The merge job once the code merged before this job (`codeMerged`, which
// GitHub confirmed). The authorization must hold for the current revision;
// the merge commit is verified, with the Reviewer's own integration for
// what that needs; then the security review of the result and the
// completion.
async function afterEarlierMerge(
  ctx: RoleContext,
  current: CurrentRevision,
  codeMerged: CodeMerged,
): Promise<RoleEnd> {
  const { code } = current.revision;
  if (code === null) {
    return errorStop(ctx.state, "the current revision has no code head");
  }
  const checks = await localChecks(ctx, ctx.state, { code, codeMerged });
  if (checks.kind === "moved") {
    return errorStop(
      ctx.state,
      `verify checked ${checks.headSha}, not ${code}`,
    );
  }
  if (checks.kind === "integrate") {
    return await integrate(ctx, ctx.state, {
      rebase: false,
      failing: checks.failing,
      why: "checks failed on the merged code",
    });
  }
  const { state } = checks;
  const fresh = await currentRevision(ctx);
  const gate = approvalGate(ctx, state, fresh);
  if (gate !== null) {
    return gate;
  }
  const { revision } = fresh;
  return await reviewedAndCompleted(ctx, state, {
    merged: { ...revision, code: codeMerged.sha },
    codeMerged,
    still: stillAt(revision),
  });
}

export { afterEarlierMerge, afterOwnMerge };
