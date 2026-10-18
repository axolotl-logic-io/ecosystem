// The merge job's end: the security review of the merged result
// (security.ts), then the publish of exactly the wiki head it reviewed and
// the completion, saved as done with what merged before the finish op
// labels and closes the issue, so a finish that fails can be run again from
// the saved completion. Nothing publishes or completes without a security
// receipt that approves exactly what merged and publishes.
//
// `state.merged` means two things by stage. At merge it is this job's own
// merge receipt, saved right after the head-matched code merge and before
// the security review: `merged.code` is the merge commit, `merged.wiki` and
// `merged.inputs` the authorized ones, and the authorized revision's code
// (state.ts mergeAuthorization) the pre-merge head the merge matched. At
// done it is the completion: the merged code and the published wiki.
//
// A change with no code left to merge (its code merged before this job, or
// it lives only in the wiki) is integrated here too: its wiki rebased onto
// the wiki's latest version and its checks fixed by the Reviewer's own
// integration (integration.ts), before the security review.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import { mergeAuthorization } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { Check, Conflict } from "../op-replies.ts";
import {
  opReply,
  SYNC_REPLY,
  VERIFY_REPLY,
  WIKI_CHECK_REPLY,
} from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { codeMergeConfirmed, currentRevision } from "../revision-source.ts";
import { errorStop } from "../writer-session.ts";
import { integrate } from "./integration.ts";
import { failed, logged, toAuthor, toReview, waiting } from "./returns.ts";
import { securityReviewed } from "./security.ts";
import { approvalGate } from "./source.ts";

const FINISHED = z.union([
  z.looseObject({ finished: z.literal(true), closed: z.boolean() }),
  z.looseObject({
    finished: z.literal(false),
    reason: z.string(),
    detail: z.string().optional(),
  }),
]);
const PUBLISHED = z.union([
  z.looseObject({
    published: z.literal(true),
    sha: z.string().nullable(),
    commits: z.array(z.string()),
  }),
  z.looseObject({
    published: z.literal(false),
    reason: z.string().optional(),
    conflicts: z.array(z.string()).optional(),
  }),
]);

// What the merge job's local checks found: nothing to do, or what its own
// integration needs.
type LocalChecks =
  | { kind: "ready"; state: IssueState }
  | { kind: "integrate"; wikiConflict: Conflict | null; failing: Check[] }
  | { kind: "moved"; headSha: string };

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

// The merge job's own checks of the authorized head `code`: verify, unless
// this head is already verified, and the wiki check. `codeMerged` is the
// code merge to verify instead of the branch.
async function localChecks(
  ctx: RoleContext,
  state: IssueState,
  { code, codeMerged }: { code: string; codeMerged: CodeMerged | null },
): Promise<LocalChecks> {
  const failing: Check[] = [];
  let checked = state;
  if (state.verifiedSha !== code) {
    let payload: object = { number: ctx.issue };
    if (codeMerged !== null) {
      payload = { number: ctx.issue, codeMerged };
    }
    const verified = await opReply(ctx, "verify", payload, VERIFY_REPLY);
    if (verified.headSha !== code) {
      return { kind: "moved", headSha: verified.headSha };
    }
    if (verified.pass) {
      checked = { ...state, verifiedSha: code };
    } else {
      failing.push(...verified.checks.filter((check) => !check.pass));
    }
  }
  const wiki = await opReply(
    ctx,
    "wiki-check",
    { number: ctx.issue },
    WIKI_CHECK_REPLY,
  );
  failing.push(...wiki.checks.filter((check) => !check.pass));
  if (failing.length > 0 || !wiki.pass) {
    return { kind: "integrate", wikiConflict: null, failing };
  }
  return { kind: "ready", state: checked };
}

// Done, with what merged and published saved first; then the finish op's
// labels and closure.
async function complete(
  ctx: RoleContext,
  state: IssueState,
  merged: Revision,
): Promise<RoleEnd> {
  const entry = `done: merged code ${short(merged.code)}, published wiki ${short(merged.wiki)}`;
  const done = logged(
    { ...state, stage: "done", merged, mergeReturn: null },
    entry,
  );
  await ctx.save(done);
  return await finish(ctx, done);
}

// The finish op on the saved completion `done`. Done only when it finished;
// new trusted inputs go to the author, and any other refusal (the wiki not
// holding the published head, or changed past it) stops, so no job retries a
// completion that can't finish.
async function finish(ctx: RoleContext, done: IssueState): Promise<RoleEnd> {
  const finished = await opReply(ctx, "finish-wiki", { state: done }, FINISHED);
  if (finished.finished) {
    return { kind: "next", state: done };
  }
  const detail = `finish-wiki refused (${finished.reason}): ${finished.detail ?? "no detail"}`;
  if (finished.reason === "inputs-changed") {
    return toAuthor(done, detail);
  }
  return failed(done, detail);
}

// Pushes the wiki at exactly `revision.wiki`; null once published, else why
// it waits. A refused publish changes nothing, and the next merge job
// integrates the wiki again.
async function publishWiki(
  ctx: RoleContext,
  state: IssueState,
  revision: Revision,
): Promise<RoleEnd | null> {
  if (revision.wiki === null) {
    return null;
  }
  const reply = await opReply(
    ctx,
    "publish",
    { state, expectedWiki: revision.wiki, revision },
    PUBLISHED,
  );
  if (reply.published) {
    return null;
  }
  const why =
    reply.reason ?? `conflicts in ${(reply.conflicts ?? []).join(", ")}`;
  return waiting(state, `the wiki publish was refused: ${why}`);
}

// The security review of the merged result `merged`, then the publish of
// its wiki for the authorized revision `authorized` and the completion.
async function reviewedAndPublished(
  ctx: RoleContext,
  state: IssueState,
  {
    merged,
    authorized,
    codeMerged,
    still,
  }: {
    merged: Revision;
    authorized: Revision;
    codeMerged: CodeMerged | null;
    still: (after: Revision) => boolean;
  },
): Promise<RoleEnd> {
  const security = await securityReviewed(ctx, state, {
    revision: merged,
    codeMerged,
    still,
  });
  if (!security.ok) {
    return security.end;
  }
  const refused = await publishWiki(ctx, security.value, authorized);
  if (refused !== null) {
    return refused;
  }
  return await complete(ctx, security.value, merged);
}

// Whether `after` still shows the code merge of `authorized` as
// `mergeCommit`, with the authorized wiki and inputs. The code head may read
// as the merge commit or as the exact pre-merge head the merge matched,
// nothing else.
function stillMerged(
  authorized: Revision,
  mergeCommit: string,
): (after: Revision) => boolean {
  return (after: Revision): boolean =>
    (after.code === mergeCommit || after.code === authorized.code) &&
    after.wiki === authorized.wiki &&
    after.inputs === authorized.inputs;
}

// After this job's own head-matched merge of `authorized.code` as
// `mergeCommit`: the receipt saved first; then, only while GitHub confirms
// that merge and the wiki head and inputs are still the authorized ones,
// the security review of the merged result, the publish and the completion.
// Anything else waits for the next claim to confirm the merge, and for
// hardening.
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
  const still = stillMerged(authorized, mergeCommit);
  const receiptHolds =
    pr !== null &&
    pr.number === start.pr &&
    pr.state === "MERGED" &&
    pr.mergeCommit === mergeCommit &&
    still(revision);
  if (start.pr === null || !receiptHolds) {
    return toReview(
      state,
      `${merged}, but GitHub or the wiki no longer match it`,
    );
  }
  return await reviewedAndPublished(ctx, state, {
    merged: { ...authorized, code: mergeCommit },
    authorized,
    codeMerged: { pr: start.pr, sha: mergeCommit },
    still,
  });
}

// A merge job after this pipeline's own code merge, whose receipt it saved
// at merge, once the claim confirmed that merge: the security review (or
// its saved receipt), the publish and the completion, with no new merge,
// while the wiki and inputs are still the merged ones. Null when they are
// not, so the issue takes the path of a change whose code merged.
async function resumeOwnMerge(
  ctx: RoleContext,
  current: CurrentRevision,
): Promise<RoleEnd | null> {
  const { state } = ctx;
  const { merged, codeMerged } = state;
  const authorized = mergeAuthorization(state);
  if (
    state.stage !== "merge" ||
    merged === null ||
    codeMerged === null ||
    authorized === null ||
    merged.code !== codeMerged.sha
  ) {
    return null;
  }
  const still = stillMerged(authorized, codeMerged.sha);
  if (!(codeMergeConfirmed(current, codeMerged) && still(current.revision))) {
    return null;
  }
  return await reviewedAndPublished(ctx, state, {
    merged,
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
      sync: false,
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
      sync: false,
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
    still: (after: Revision): boolean =>
      after.code === revision.code &&
      after.wiki === revision.wiki &&
      after.inputs === revision.inputs,
  });
}

// A done issue with its completion saved, back at merge because the finish
// op didn't finish it: the finish op again, and nothing else, once the
// trusted inputs are still the merged ones, GitHub still confirms the
// merged code and a security receipt approves exactly what merged. A
// completion with no such receipt (one an earlier pipeline saved) gets its
// security review first; one the receipt rejects stops again.
async function finishCompleted(
  ctx: RoleContext,
  state: IssueState,
  merged: Revision,
): Promise<RoleEnd> {
  const { revision, pr } = await currentRevision(ctx);
  const { gherkin } = ctx.inputs;
  if (
    gherkin === null ||
    gherkin.inputs !== revision.inputs ||
    merged.inputs !== revision.inputs
  ) {
    return toAuthor(state, "the trusted inputs changed since the merge");
  }
  const codeConfirmed =
    merged.code === null ||
    (pr !== null &&
      pr.number === state.pr &&
      pr.state === "MERGED" &&
      pr.mergeCommit === merged.code);
  if (!codeConfirmed) {
    return failed(
      state,
      `the completion records code ${merged.code} merged, and GitHub doesn't confirm PR #${state.pr} merged as it`,
    );
  }
  let codeMerged: CodeMerged | null = null;
  if (merged.code !== null && state.pr !== null) {
    codeMerged = { pr: state.pr, sha: merged.code };
  }
  const security = await securityReviewed(ctx, state, {
    revision: merged,
    codeMerged,
    still: (after: Revision): boolean =>
      after.inputs === merged.inputs &&
      (merged.code === null || after.code === merged.code),
  });
  if (!security.ok) {
    return security.end;
  }
  return await finish(ctx, security.value);
}

export type { LocalChecks };
export {
  afterOwnMerge,
  finishCompleted,
  localChecks,
  publishOnly,
  resumeOwnMerge,
};
