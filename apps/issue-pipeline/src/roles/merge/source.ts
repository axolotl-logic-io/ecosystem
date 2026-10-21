// The gate the merge job's revision must pass, read fresh from the ops just
// before each mutation: the Gherkin is for the current trusted inputs, a
// recorded code merge is still what GitHub says, and the merge
// authorization (state.ts mergeAuthorization: the hardened revision)
// holds for exactly this code head and
// inputs revision (`approval-is-for-one-revision`).

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { targetHolds } from "../../reviewed-target.ts";
import type { IssueState } from "../../state.ts";
import { approvalHolds } from "../../state.ts";
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
    return toReview(state, "no exact hardening holds for the current revision");
  }
  if (
    codeMerged === null &&
    !targetHolds(ctx.cfg, state.hardenedTarget, current.baseSha)
  ) {
    return toReview(
      state,
      "the target context needs fresh hardening and checks",
    );
  }
  return null;
}

export { approvalGate };
