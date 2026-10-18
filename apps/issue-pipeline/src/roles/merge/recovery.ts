// An interrupted own merge resumes only from its saved exact receipt and
// original authorization, independently confirmed against GitHub's PR head
// and merge commit. codeMerged stays an authoritative fact, not a reason
// to pretend hardening covered the merge SHA. Unchanged work needs only
// its missing security review and publication, never another writer.

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { mergeAuthorization } from "../../state.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { checkedMergedResult } from "./checks.ts";
import { reviewedAndPublished, stillAt } from "./completion.ts";
import { toAuthor } from "./returns.ts";

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

export { recoverOwnMerge };
