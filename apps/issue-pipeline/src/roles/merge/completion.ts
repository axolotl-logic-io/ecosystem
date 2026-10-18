// The merge job's end: the security review of the merged result
// (security.ts), then the publish of exactly the wiki head it reviewed and
// the completion, saved as done with what merged before the finish op
// labels and closes the issue, so a finish that fails can be run again from
// the saved completion. Nothing publishes or completes without a security
// receipt that approves exactly what merged and publishes; a done issue
// back at merge gets the finish op again only with such a receipt.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply } from "../op-replies.ts";
import { currentRevision } from "../revision-source.ts";
import { failed, logged, toAuthor, waiting } from "./returns.ts";
import { securityReviewed } from "./security.ts";

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
  return sha?.slice(0, SHORT_SHA) ?? "none";
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

// Whether `after` is still exactly `revision`.
function stillAt(revision: Revision): (after: Revision) => boolean {
  return (after: Revision): boolean => sameRevision(after, revision);
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

export { finishCompleted, reviewedAndPublished, stillAt };
