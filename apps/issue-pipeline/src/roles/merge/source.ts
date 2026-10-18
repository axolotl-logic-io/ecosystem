// The revision the merge job may merge and publish, read fresh from the ops
// just before each mutation, and the gate it must pass: the Gherkin is for
// the current trusted inputs, a recorded code merge is still what GitHub
// says, and the approval holds for exactly this code head, wiki head and
// inputs revision (`approval-is-for-one-revision`).

import { z } from "zod";
import type { OpName, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState } from "../../state.ts";
import { approvalHolds } from "../../state.ts";
import { failed, toAuthor, toReview } from "./returns.ts";

const CURRENT_REVISION = z.looseObject({
  revision: z.object({
    code: z.string().nullable(),
    wiki: z.string().nullable(),
    inputs: z.string().min(1),
  }),
  baseSha: z.string(),
  pr: z
    .looseObject({
      number: z.number().int().positive(),
      state: z.string(),
      mergeCommit: z.string().nullable(),
    })
    .nullable(),
});

type CurrentRevision = z.infer<typeof CURRENT_REVISION>;

// Runs op `name` and checks its reply against `schema`; a reply of another
// shape is an error, never read as a success.
async function opReply<T extends z.ZodType>(
  ctx: RoleContext,
  name: OpName,
  payload: object,
  schema: T,
): Promise<z.infer<T>> {
  const reply = await ctx.op(name, payload);
  const parsed = schema.safeParse(reply);
  if (!parsed.success) {
    throw new Error(`${name}: unexpected reply: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function currentRevision(ctx: RoleContext): Promise<CurrentRevision> {
  return await opReply(
    ctx,
    "current-revision",
    { state: ctx.state },
    CURRENT_REVISION,
  );
}

// Whether GitHub confirms the code merge the claim recorded: the same PR,
// merged, at the same merge commit, which is also the code revision.
function codeMergeConfirmed(
  current: CurrentRevision,
  codeMerged: CodeMerged,
): boolean {
  const { pr, revision } = current;
  return (
    pr !== null &&
    pr.number === codeMerged.pr &&
    pr.state === "MERGED" &&
    pr.mergeCommit === codeMerged.sha &&
    revision.code === codeMerged.sha
  );
}

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
    return toReview(state, "no approval holds for the current revision");
  }
  return null;
}

export type { CurrentRevision };
export { approvalGate, codeMergeConfirmed, currentRevision, opReply };
