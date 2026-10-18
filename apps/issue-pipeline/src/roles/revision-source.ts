// The issue's revision as the Reviewer reads it, fresh from the
// `current-revision` op: its code head, wiki head and trusted-inputs
// revision, and its PR as GitHub reports it. The Reviewer reads it before
// and after each step that binds a revision, so a verdict, a hardening or an
// integration of a revision that moved meanwhile is never recorded.

import { z } from "zod";
import type { RoleContext } from "../job/role-context.ts";
import type { CodeMerged } from "../state.ts";
import { opReply } from "./op-replies.ts";

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

export type { CurrentRevision };
export { codeMergeConfirmed, currentRevision };
