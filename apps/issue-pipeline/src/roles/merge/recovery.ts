// An interrupted own merge resumes only from its saved exact receipt and
// original authorization, independently confirmed against GitHub's PR head
// and merge commit. codeMerged stays an authoritative fact, not a reason
// to pretend hardening covered the merge SHA. Unchanged work needs only
// read-only confirmation of its premerge checks and Security, then its
// completion: never a postmerge suite or another writer (#185).

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { legacyWikiOf } from "../../merge-provenance.ts";
import { recordedAuthorization } from "../../merged-authorization.ts";
import { requirementsHold } from "../../requirements.ts";
import { currentResultObservation } from "../../security-clearance.ts";
import { opReply } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { afterOwnMerge } from "./after-merge.ts";
import { confirmedMergedResult, landBindingOf } from "./checks.ts";
import { reviewedAndCompleted } from "./completion.ts";
import { toRequirements } from "./returns.ts";

const OWN_MERGE_INPUTS_CHANGED =
  "the trusted inputs changed since the own merge";

const MERGE_REPLY = z.union([
  z.looseObject({
    merged: z.literal(true),
    mergeCommit: z.string().min(1),
    headSha: z.string().min(1),
    byHand: z.boolean().optional(),
  }),
  z.looseObject({ merged: z.literal(false), reason: z.string().min(1) }),
]);

// Unconfirmed attempts are reconciled before any ordinary approval/integration
// path. External merged truth without an own receipt stops in merge.ts.
async function recoverAttempt(ctx: RoleContext): Promise<RoleEnd | null> {
  const { state } = ctx;
  const attempt = state.mergeAttempt;
  if (attempt === null || state.merged !== null) {
    return null;
  }
  if (
    attempt.result === null &&
    state.codeMerged !== null &&
    recordedAuthorization(state)?.code === state.codeMerged.sha
  ) {
    return null;
  }
  // With the attempt's Land binding, the read also settles that Land.
  const binding = landBindingOf(ctx, state);
  let request: object = { number: ctx.issue };
  if (binding !== null) {
    request = { ...request, binding };
  }
  const reply = await opReply(ctx, "reconcile-merge", request, MERGE_REPLY);
  if (!reply.merged || reply.byHand === true) {
    let reason =
      "observed external merged truth has no saved successful response; read-only reconciliation is required";
    if (!reply.merged) {
      ({ reason } = reply);
    }
    return { kind: "stop", code: "merge-refused", reason, state };
  }
  return await afterOwnMerge(ctx, state, {
    authorized: attempt.authorized,
    mergeCommit: reply.mergeCommit,
  });
}

// Null means this is not an unchanged own merge; the ordinary approval
// gate must handle it. A codeMerged fact alone authorizes no recovery.
async function recoverOwnMerge(
  ctx: RoleContext,
  current: CurrentRevision,
): Promise<RoleEnd | null> {
  const { state } = ctx;
  const { merged, codeMerged } = state;
  const authorized = recordedAuthorization(state);
  if (
    state.stage !== "merge" ||
    merged === null ||
    merged.code === null ||
    authorized === null ||
    authorized.code === null
  ) {
    return null;
  }
  const { revision, pr } = current;
  const { gherkin } = ctx.inputs;
  if (
    !requirementsHold(state, gherkin, revision.inputs) ||
    authorized.inputs !== revision.inputs ||
    merged.inputs !== revision.inputs
  ) {
    return toRequirements(state, OWN_MERGE_INPUTS_CHANGED);
  }
  if (
    pr === null ||
    state.pr !== pr.number ||
    pr.state !== "MERGED" ||
    pr.headSha !== authorized.code ||
    pr.mergeCommit !== merged.code ||
    revision.code !== merged.code ||
    legacyWikiOf(authorized) !== legacyWikiOf(merged) ||
    (authorized.policy ?? null) !== (merged.policy ?? null) ||
    legacyWikiOf(revision) !== legacyWikiOf(merged)
  ) {
    return null;
  }
  if (
    codeMerged !== null &&
    (codeMerged.pr !== pr.number || codeMerged.sha !== merged.code)
  ) {
    return null;
  }
  const result = currentResultObservation(merged, revision);
  if (result === null) {
    return null;
  }
  const receipt = { pr: pr.number, sha: merged.code };
  const refused = await confirmedMergedResult(ctx, state, result, receipt);
  if (refused !== null) {
    return refused;
  }
  return await reviewedAndCompleted(ctx, state, {
    merged,
    result,
  });
}

export { MERGE_REPLY, recoverAttempt, recoverOwnMerge };
