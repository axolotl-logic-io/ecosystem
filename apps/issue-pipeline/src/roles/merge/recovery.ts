// An interrupted own merge resumes only from its saved exact receipt and
// original authorization, independently confirmed against GitHub's PR head
// and merge commit. codeMerged stays an authoritative fact, not a reason
// to pretend hardening covered the merge SHA. Unchanged work needs only
// its missing security review and publication, never another writer.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { mergeAuthorization } from "../../state.ts";
import { opReply } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { checkedMergedResult } from "./checks.ts";
import { reviewedAndPublished, stillAt } from "./completion.ts";
import { afterOwnMerge } from "./publish.ts";
import { toAuthor } from "./returns.ts";

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
// path. Independent postmerge hardening can still authorize external work.
async function recoverAttempt(ctx: RoleContext): Promise<RoleEnd | null> {
  const { state } = ctx;
  const attempt = state.mergeAttempt;
  if (attempt === null || state.merged !== null) {
    return null;
  }
  if (
    attempt.result === null &&
    state.codeMerged !== null &&
    mergeAuthorization(state)?.code === state.codeMerged.sha
  ) {
    return null;
  }
  const reply = await opReply(
    ctx,
    "reconcile-merge",
    { number: ctx.issue },
    MERGE_REPLY,
  );
  if (!reply.merged || reply.byHand === true) {
    let reason =
      "observed external merged truth has no saved successful response; independent postmerge authorization is required";
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
  const authorized = mergeAuthorization(state);
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
    gherkin === null ||
    gherkin.inputs !== revision.inputs ||
    authorized.inputs !== revision.inputs ||
    merged.inputs !== revision.inputs
  ) {
    return toAuthor(state, "the trusted inputs changed since the own merge");
  }
  if (
    pr === null ||
    state.pr !== pr.number ||
    pr.state !== "MERGED" ||
    pr.headSha !== authorized.code ||
    pr.mergeCommit !== merged.code ||
    revision.code !== merged.code ||
    authorized.wiki !== merged.wiki ||
    revision.wiki !== merged.wiki
  ) {
    return null;
  }
  if (
    codeMerged !== null &&
    (codeMerged.pr !== pr.number || codeMerged.sha !== merged.code)
  ) {
    return null;
  }
  const receipt = { pr: pr.number, sha: merged.code };
  const checked = await checkedMergedResult(ctx, state, merged, receipt);
  if ("end" in checked) {
    return checked.end;
  }
  return await reviewedAndPublished(ctx, checked.state, {
    merged,
    authorized,
    codeMerged: receipt,
    still: stillAt(merged),
  });
}

export { MERGE_REPLY, recoverAttempt, recoverOwnMerge };
