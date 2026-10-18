// The merge job's verify: the repo's configured checks on the code head it is
// about to merge, or on the merge commit after the code merged, run by the
// verify op. The merge job verifies only a head not verified yet.

import { z } from "zod";
import type { RoleContext } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { opReply } from "./source.ts";

const VERIFY = z.looseObject({
  pass: z.boolean(),
  headSha: z.string(),
  checks: z.array(
    z.looseObject({ id: z.string(), pass: z.boolean(), detail: z.string() }),
  ),
});

// The verify's outcome for the head `expected`: verified (the state records
// it), verify checked another head, or checks failed.
type Verification =
  | { kind: "verified"; state: IssueState }
  | { kind: "moved"; headSha: string }
  | { kind: "failed"; detail: string };

async function verifyHead(
  ctx: RoleContext,
  state: IssueState,
  { expected, payload }: { expected: string; payload: object },
): Promise<Verification> {
  const reply = await opReply(ctx, "verify", payload, VERIFY);
  if (reply.headSha !== expected) {
    return { kind: "moved", headSha: reply.headSha };
  }
  if (!reply.pass) {
    const failing = reply.checks
      .filter((check) => !check.pass)
      .map((check) => `${check.id}: ${check.detail}`);
    return { kind: "failed", detail: failing.join("; ") || "verify failed" };
  }
  return { kind: "verified", state: { ...state, verifiedSha: expected } };
}

export type { Verification };
export { verifyHead };
