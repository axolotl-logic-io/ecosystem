// The gate the merge job's revision must pass, read fresh from the ops just
// before each mutation: the Gherkin is for the current trusted inputs, a
// recorded code merge is still what GitHub says, and the merge
// authorization (state.ts mergeAuthorization: the hardened revision, or the
// Reviewer's own integration of it) holds for exactly this code head, wiki
// head and inputs revision (`approval-is-for-one-revision`).

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { approvalHolds, mergeAuthorization } from "../../state.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { codeMergeConfirmed } from "../revision-source.ts";
import { failed, toAuthor, toReview } from "./returns.ts";

// Why the merge job may not go on with `current` from `state`, or null when
// it may.
function approvalGate(
  ctx: RoleContext,
  state: IssueState,
  current: CurrentRevision,
): RoleEnd | null {
  const { gherkin } = ctx.inputs;
  const { revision } = current;
  if (gherkin === null || gherkin.inputs !== revision.inputs) {
    return toAuthor(state, "the trusted inputs changed since the Gherkin");
  }
  const { codeMerged } = state;
  if (codeMerged !== null && !codeMergeConfirmed(current, codeMerged)) {
    return failed(
      state,
      `GitHub doesn't confirm PR #${codeMerged.pr} merged as ${codeMerged.sha}, as the claim recorded`,
    );
  }
  if (!approvalHolds(state, revision)) {
    return toReview(
      state,
      "no hardening or own integration holds for the current revision",
    );
  }
  return null;
}

// Only the wiki rewrite has been attributed by deterministic recovery. Every
// other source gate must still hold before entering integration, not just merge.
function recoveredApprovalGate(
  ctx: RoleContext,
  state: IssueState,
  current: CurrentRevision,
): RoleEnd | null {
  const from = mergeAuthorization(state);
  if (from === null) {
    return approvalGate(ctx, state, current);
  }
  return approvalGate(ctx, state, {
    ...current,
    revision: { ...current.revision, wiki: from.wiki },
  });
}

export { approvalGate, recoveredApprovalGate };
