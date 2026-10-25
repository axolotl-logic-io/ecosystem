// Exact-head checks run before the target moves; after Land, only read-only
// confirmation of that pre-Land proof (#185). Completion consumes the exact
// Land result when the landing attempt was made under one (#186); a Land from
// before activation has none and confirms as before.
import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import type { Binding } from "../../task-result-records.ts";
import { opReply } from "../op-replies.ts";
import { taskStatus } from "../task-results.ts";
import { failed } from "./returns.ts";
import { rejectedAgain } from "./security.ts";

const CONFIRMED_REPLY = z.union([
  z.looseObject({ confirmed: z.literal(true), headSha: z.string().min(1) }),
  z.looseObject({ confirmed: z.literal(false), reason: z.string().min(1) }),
]);

// The read-only path when exact pre-Land proof is missing or unconfirmed.
const NO_POST_LAND_REPAIR =
  "code remains merged; no postmerge suite, writer or retrospective Security runs; read-only reconciliation is required";

// The Land binding the saved landing attempt was made under: its authorized
// revision on the target commit it fast-forwarded. Null for an attempt that
// can't name one, such as a historical attempt without a policy or intent.
function landBindingOf(ctx: RoleContext, state: IssueState): Binding | null {
  const attempt = state.mergeAttempt;
  if (attempt === null || attempt.operation === undefined) {
    return null;
  }
  const { code, inputs, policy } = attempt.authorized;
  if (code === null || policy === undefined) {
    return null;
  }
  return {
    repo: ctx.cfg.repo,
    workItem: ctx.issue,
    task: "Land",
    revision: { code, inputs, policy },
    target: { branch: ctx.cfg.baseBranch, commit: attempt.operation.base },
  };
}

// The Land binding Completion consumes: `land`, the one this job just
// landed under, else the saved attempt's; null for a Land from before
// activation that recorded no Land; or why Completion must hold.
async function completionBinding(
  ctx: RoleContext,
  state: IssueState,
  land: Binding | null,
): Promise<{ binding: Binding | null } | { hold: string }> {
  const binding = land ?? landBindingOf(ctx, state);
  if (binding === null) {
    return { binding: null };
  }
  const { status } = await taskStatus(ctx, binding);
  if (status === "passed") {
    return { binding };
  }
  if (status === "missing") {
    return { binding: null };
  }
  return {
    hold: `the Land of this merge is ${status}, not a confirmed delivery`,
  };
}

// Post-Land confirmation, read-only: a saved rejection stops again; then the
// `confirm-merged` op requires the signed fast-forward intent, its receipt and
// the pre-Land check proof for exactly `codeMerged.sha`, and confirms GitHub's
// receipt and ancestry. Missing proof is a stop, never a post-Land suite or a
// request for a code writer. Null means the result may go on to completion.
// `landed` is the Land binding this job just landed under, when it did.
async function confirmedLandedResult(
  ctx: RoleContext,
  state: IssueState,
  merge: { result: Revision; codeMerged: CodeMerged; landed?: Binding | null },
): Promise<RoleEnd | null> {
  const { result, codeMerged, landed = null } = merge;
  const rejected = rejectedAgain(state, result);
  if (rejected !== null) {
    return rejected;
  }
  const land = await completionBinding(ctx, state, landed);
  if ("hold" in land) {
    return failed(state, `${land.hold}; ${NO_POST_LAND_REPAIR}`);
  }
  let request: object = { number: ctx.issue, codeMerged };
  if (land.binding !== null) {
    request = { ...request, binding: land.binding };
  }
  const confirmed = await opReply(
    ctx,
    "confirm-merged",
    request,
    CONFIRMED_REPLY,
  );
  if (!confirmed.confirmed) {
    return failed(state, `${confirmed.reason}; ${NO_POST_LAND_REPAIR}`);
  }
  if (confirmed.headSha !== codeMerged.sha) {
    return failed(
      state,
      `confirm-merged read ${confirmed.headSha}, not ${codeMerged.sha}; ${NO_POST_LAND_REPAIR}`,
    );
  }
  return null;
}

export { confirmedLandedResult, landBindingOf, NO_POST_LAND_REPAIR };
