// Exact-head checks run before the target moves; after Land, only read-only
// confirmation of that premerge proof (#185).
import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import type { Check } from "../op-replies.ts";
import { opReply, VERIFY_REPLY } from "../op-replies.ts";
import { failed } from "./returns.ts";
import { rejectedAgain } from "./security.ts";

const CONFIRMED_REPLY = z.union([
  z.looseObject({ confirmed: z.literal(true), headSha: z.string().min(1) }),
  z.looseObject({ confirmed: z.literal(false), reason: z.string().min(1) }),
]);

// The read-only path when exact premerge proof is missing or unconfirmed.
const NO_POSTMERGE_REPAIR =
  "code remains merged; no postmerge suite, writer or retrospective Security runs; read-only reconciliation is required";

// What the merge job's local checks found: nothing to do, or what its own
// integration needs.
type LocalChecks =
  | { kind: "ready"; state: IssueState }
  | { kind: "integrate"; failing: Check[] }
  | { kind: "moved"; headSha: string };

// The merge job's own checks of the authorized branch head `code`, before
// any target mutation: verify, unless this head is already verified.
async function localChecks(
  ctx: RoleContext,
  state: IssueState,
  code: string,
): Promise<LocalChecks> {
  if (state.verifiedSha === code) {
    return { kind: "ready", state };
  }
  const verified = await opReply(
    ctx,
    "verify",
    { number: ctx.issue },
    VERIFY_REPLY,
  );
  if (verified.headSha !== code) {
    return { kind: "moved", headSha: verified.headSha };
  }
  if (!verified.pass) {
    const failing = verified.checks.filter((check) => !check.pass);
    return { kind: "integrate", failing };
  }
  return { kind: "ready", state: { ...state, verifiedSha: code } };
}

// Post-Land confirmation, read-only: a saved rejection stops again; then the
// confirm-merged op requires the signed fast-forward intent, its receipt and
// the premerge check proof for exactly `codeMerged.sha`, and confirms GitHub's
// receipt and ancestry. Missing proof is a stop, never a postmerge suite or a
// request for a code writer. Null means the result may go on to completion.
async function confirmedMergedResult(
  ctx: RoleContext,
  state: IssueState,
  result: Revision,
  codeMerged: CodeMerged,
): Promise<RoleEnd | null> {
  const rejected = rejectedAgain(state, result);
  if (rejected !== null) {
    return rejected;
  }
  const confirmed = await opReply(
    ctx,
    "confirm-merged",
    { number: ctx.issue, codeMerged },
    CONFIRMED_REPLY,
  );
  if (!confirmed.confirmed) {
    return failed(state, `${confirmed.reason}; ${NO_POSTMERGE_REPAIR}`);
  }
  if (confirmed.headSha !== codeMerged.sha) {
    return failed(
      state,
      `confirm-merged read ${confirmed.headSha}, not ${codeMerged.sha}; ${NO_POSTMERGE_REPAIR}`,
    );
  }
  return null;
}

export type { LocalChecks };
export { confirmedMergedResult, localChecks, NO_POSTMERGE_REPAIR };
