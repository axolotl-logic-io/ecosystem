// The merge job's wiki side and its end: the issue's wiki commits rebased
// onto the wiki's latest version and checked before anything merges, the
// publish of exactly the reviewed wiki head, and the completion, saved as
// done with what merged before the finish op labels and closes the issue, so
// a finish that fails can be run again from the saved completion.
//
// `state.merged` means two things by stage. At merge it is this job's own
// merge receipt, saved right after the head-matched code merge and before
// the publish: `merged.code` is the merge commit, `merged.wiki` and
// `merged.inputs` the approved ones, and the unchanged `review.revision.code`
// the pre-merge head the merge matched. At done it is the completion: the
// merged code and the published wiki.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, Revision } from "../../state.ts";
import {
  failed,
  logged,
  syncedToReview,
  toAuthor,
  toImplement,
  toReview,
  waiting,
} from "./returns.ts";
import type { CurrentRevision } from "./source.ts";
import { approvalGate, currentRevision, opReply } from "./source.ts";
import { verifyHead } from "./verify.ts";

const SHORT_SHA_LENGTH = 12;

const WIKI_SYNC = z.union([
  z.looseObject({
    conflict: z.literal(false),
    changed: z.boolean(),
    headSha: z.string(),
  }),
  z.looseObject({ conflict: z.literal(true), conflicts: z.array(z.string()) }),
]);
const WIKI_CHECK = z.looseObject({
  pass: z.boolean(),
  checks: z.array(z.looseObject({ id: z.string(), detail: z.string() })),
});
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

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA_LENGTH) ?? "none";
}

// Null when the issue's wiki commits are rebased onto the wiki's latest
// version, unchanged by that, and pass the wiki check; else where they go.
async function wikiReady(
  ctx: RoleContext,
  state: IssueState,
  current: CurrentRevision,
): Promise<RoleEnd | null> {
  if (current.revision.wiki === null) {
    return null;
  }
  const sync = await opReply(ctx, "wiki-sync", {}, WIKI_SYNC);
  if (sync.conflict) {
    await ctx.op("finish-wiki-sync", {
      abort: true,
      reason: "the merge job leaves a wiki conflict to the implementor",
    });
    const files = sync.conflicts.join(", ");
    const detail = `rebasing the wiki commits onto the wiki's latest version conflicted in ${files}`;
    return toImplement(ctx, state, "wiki-conflict", detail);
  }
  if (sync.changed) {
    const why = `the wiki commits were rebased onto the wiki's latest version as ${short(sync.headSha)}`;
    return syncedToReview(ctx, state, why);
  }
  const check = await opReply(ctx, "wiki-check", {}, WIKI_CHECK);
  if (!check.pass) {
    const detail = check.checks.map((item) => item.detail).join("; ");
    return toImplement(ctx, state, "wiki-check", detail);
  }
  return null;
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
// rebases the wiki again, which sends a moved head to review.
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

// After this job's own head-matched merge of `approved.code` as
// `mergeCommit`: the receipt saved first, then the approved wiki published
// only while GitHub confirms that merge and the wiki head and inputs are
// still the approved ones. The code head may read as the merge commit or as
// the exact pre-merge head the merge matched, nothing else. Anything else
// waits for the next claim to confirm the merge and for a review.
async function afterOwnMerge(
  ctx: RoleContext,
  start: IssueState,
  { approved, mergeCommit }: { approved: Revision; mergeCommit: string },
): Promise<RoleEnd> {
  const merged = `PR #${start.pr} merged as ${short(mergeCommit)}`;
  const state = logged(
    { ...start, merged: { ...approved, code: mergeCommit } },
    `merged PR #${start.pr} at ${approved.code} as ${mergeCommit}`,
  );
  await ctx.save(state);
  const fresh = await currentRevision(ctx);
  const { gherkin } = ctx.inputs;
  const { revision, pr } = fresh;
  if (
    gherkin === null ||
    revision.inputs !== approved.inputs ||
    gherkin.inputs !== revision.inputs
  ) {
    return toAuthor(state, `${merged}, then the trusted inputs changed`);
  }
  const receiptHolds =
    pr !== null &&
    pr.number === state.pr &&
    pr.state === "MERGED" &&
    pr.mergeCommit === mergeCommit &&
    (revision.code === mergeCommit || revision.code === approved.code) &&
    revision.wiki === approved.wiki;
  if (!receiptHolds) {
    return toReview(
      state,
      `${merged}, but GitHub or the wiki no longer match it`,
    );
  }
  const refused = await publishWiki(ctx, state, approved);
  if (refused !== null) {
    return refused;
  }
  return await complete(ctx, state, { ...approved, code: mergeCommit });
}

// The merge job when no code is left to merge: the code merged before this
// job (`state.codeMerged`, which GitHub confirmed), or the change lives only
// in the wiki. The approval must be for the current revision, the merge
// commit is verified, and the wiki is rebased, checked and published.
async function publishOnly(
  ctx: RoleContext,
  current: CurrentRevision,
): Promise<RoleEnd> {
  let { state } = ctx;
  const { codeMerged } = state;
  if (codeMerged !== null && state.verifiedSha !== codeMerged.sha) {
    const check = await verifyHead(ctx, state, {
      expected: codeMerged.sha,
      payload: { codeMerged },
    });
    if (check.kind === "moved") {
      return failed(
        state,
        `verify checked ${check.headSha}, not the merge commit ${codeMerged.sha}`,
      );
    }
    if (check.kind === "failed") {
      return toImplement(ctx, state, "retest", check.detail);
    }
    ({ state } = check);
  }
  const ready = await wikiReady(ctx, state, current);
  if (ready !== null) {
    return ready;
  }
  const fresh = await currentRevision(ctx);
  const gate = approvalGate(ctx, state, fresh);
  if (gate !== null) {
    return gate;
  }
  const refused = await publishWiki(ctx, state, fresh.revision);
  if (refused !== null) {
    return refused;
  }
  // A change that lives only in the wiki merged no code.
  const code = codeMerged?.sha ?? null;
  return await complete(ctx, state, { ...fresh.revision, code });
}

// A done issue with its completion saved, back at merge because the finish
// op didn't finish it: the finish op again, and nothing else, once the
// trusted inputs are still the merged ones and GitHub still confirms the
// merged code. New inputs go to the author rather than close a new request.
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
  return await finish(ctx, state);
}

export { afterOwnMerge, finishCompleted, publishOnly, wikiReady };
