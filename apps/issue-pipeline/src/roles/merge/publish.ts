// The merge job's way to the security review of the merged result and the
// completion (completion.ts), after a code merge or with no code to merge.
//
// `state.merged` means two things by stage. At merge it is this job's own
// merge receipt, saved right after the explicit-target code merge and before
// the security review: `merged.code` is the merge commit, `merged.wiki` and
// `merged.inputs` the authorized ones, and the authorized revision's code
// (state.ts mergeAuthorization) the pre-merge head the merge matched. At
// done it is the completion: the merged code and the published wiki.
//
// A change with no code left to merge (its code merged before this job, or
// it lives only in the wiki) is integrated here too: its wiki rebased onto
// the wiki's latest version and its checks fixed by the Reviewer's own
// integration (integration.ts), before the security review.

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, Revision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { Conflict } from "../op-replies.ts";
import { opReply, SYNC_REPLY } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { currentRevision } from "../revision-source.ts";
import { errorStop } from "../writer-session.ts";
import { checkedMergedResult, localChecks } from "./checks.ts";
import { reviewedAndPublished, stillAt } from "./completion.ts";
import { integrate } from "./integration.ts";
import { logged, toAuthor } from "./returns.ts";
import { approvalGate } from "./source.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The wiki-side need of a change with no code left to merge: its wiki
// rebased onto the wiki's latest version. A rebase that changed the wiki,
// or stopped on conflicts, needs the Reviewer's own integration.
async function wikiSynced(
  ctx: RoleContext,
  current: CurrentRevision,
): Promise<{ changed: boolean; conflict: Conflict | null }> {
  if (current.revision.wiki === null || ctx.dirs.docs === null) {
    return { changed: false, conflict: null };
  }
  const sync = await opReply(
    ctx,
    "wiki-sync",
    { number: ctx.issue },
    SYNC_REPLY,
  );
  if (sync.conflict) {
    return { changed: true, conflict: sync };
  }
  return { changed: sync.changed, conflict: null };
}

// After this job's own explicit-target merge of `authorized.code` as
// `mergeCommit`: the receipt saved first; then, only while GitHub confirms
// that merge and the wiki head and inputs are still the authorized ones,
// the security review of the merged result, the publish and the completion.
// Anything else goes back to review. An interrupted job resumes an exact
// saved own-merge receipt through recovery.ts, preserving its original
// authorization; changed work instead needs hardening against the merged
// code before this module takes its publish-only path.
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
    gherkin === null ||
    revision.inputs !== authorized.inputs ||
    gherkin.inputs !== revision.inputs
  ) {
    return toAuthor(state, `${merged}, then the trusted inputs changed`);
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
      `${merged}, but GitHub or the wiki no longer match it; merged truth is retained`,
    );
  }
  const codeMerged = { pr: start.pr, sha: mergeCommit };
  const checked = await checkedMergedResult(ctx, state, result, codeMerged);
  if ("end" in checked) {
    return checked.end;
  }
  return await reviewedAndPublished(ctx, checked.state, {
    merged: result,
    authorized,
    codeMerged,
    still,
  });
}

// The merge job when no code is left to merge: the code merged before this
// job (`state.codeMerged`, which GitHub confirmed), or the change lives only
// in the wiki. The authorization must hold for the current revision; the
// wiki is rebased, and the merge commit verified and the wiki checked, with
// the Reviewer's own integration for what they need; then the security
// review of the result, the publish and the completion.
async function publishOnly(
  ctx: RoleContext,
  current: CurrentRevision,
): Promise<RoleEnd> {
  const { codeMerged } = ctx.state;
  const wiki = await wikiSynced(ctx, current);
  if (wiki.changed) {
    return await integrate(ctx, ctx.state, {
      rebase: { code: false, wiki: false },
      wikiConflict: wiki.conflict,
      failing: [],
      why: "the wiki moved past the change's wiki commits",
    });
  }
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
      rebase: { code: false, wiki: false },
      wikiConflict: checks.wikiConflict,
      failing: checks.failing,
      why: "checks failed before the publish",
    });
  }
  const { state } = checks;
  const fresh = await currentRevision(ctx);
  const gate = approvalGate(ctx, state, fresh);
  if (gate !== null) {
    return gate;
  }
  const { revision } = fresh;
  // A change that lives only in the wiki merged no code.
  const merged: Revision = { ...revision, code: codeMerged?.sha ?? null };
  return await reviewedAndPublished(ctx, state, {
    merged,
    authorized: revision,
    codeMerged,
    still: stillAt(revision),
  });
}

export { afterOwnMerge, publishOnly };
