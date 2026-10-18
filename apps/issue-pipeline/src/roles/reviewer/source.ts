// What the reviewer reviews, read fresh from the ops: the `current-revision`
// op's code head, wiki head and trusted-inputs revision, and the issue's PR as
// GitHub reports it. The reviewer reads it before and after its session, so a
// verdict on a revision that moved while it read is never recorded.

import { z } from "zod";
import type { RoleContext } from "../../job/role-context.ts";
import type { CodeMerged, Revision } from "../../state.ts";

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
  const reply = await ctx.op("current-revision", { state: ctx.state });
  const parsed = CURRENT_REVISION.safeParse(reply);
  if (!parsed.success) {
    throw new Error(
      `current-revision: unexpected reply: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function sameRevision(a: Revision, b: Revision): boolean {
  return a.code === b.code && a.wiki === b.wiki && a.inputs === b.inputs;
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
export { codeMergeConfirmed, currentRevision, sameRevision };
