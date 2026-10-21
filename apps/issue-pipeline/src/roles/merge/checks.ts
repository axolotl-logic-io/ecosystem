// Exact-head checks used before integration and on actual merged results.
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import type { Check } from "../op-replies.ts";
import { opReply, VERIFY_REPLY } from "../op-replies.ts";
import { failed } from "./returns.ts";
import { rejectedAgain } from "./security.ts";

// What the merge job's local checks found: nothing to do, or what its own
// integration needs.
type LocalChecks =
  | { kind: "ready"; state: IssueState }
  | { kind: "integrate"; failing: Check[] }
  | { kind: "moved"; headSha: string };

// The merge job's own checks of the authorized head `code`: verify, unless
// this head is already verified. `codeMerged` is the code merge to verify
// instead of the branch.
async function localChecks(
  ctx: RoleContext,
  state: IssueState,
  { code, codeMerged }: { code: string; codeMerged: CodeMerged | null },
): Promise<LocalChecks> {
  if (codeMerged === null && state.verifiedSha === code) {
    return { kind: "ready", state };
  }
  let payload: object = { number: ctx.issue };
  if (codeMerged !== null) {
    payload = { number: ctx.issue, codeMerged };
  }
  const verified = await opReply(ctx, "verify", payload, VERIFY_REPLY);
  if (verified.headSha !== code) {
    return { kind: "moved", headSha: verified.headSha };
  }
  if (!verified.pass) {
    const failing = verified.checks.filter((check) => !check.pass);
    return { kind: "integrate", failing };
  }
  return { kind: "ready", state: { ...state, verifiedSha: code } };
}

// A postmerge failure is a stop, never a request for a code writer. Repeat
// deterministic verification on recovery even when verifiedSha is M: this
// also reestablishes genuine receipt/ancestry/whole-delta graph coverage.
async function checkedMergedResult(
  ctx: RoleContext,
  state: IssueState,
  merged: Revision,
  codeMerged: CodeMerged,
): Promise<{ state: IssueState } | { end: RoleEnd }> {
  const rejected = rejectedAgain(state, merged);
  if (rejected !== null) {
    return { end: rejected };
  }
  const checks = await localChecks(ctx, state, {
    code: codeMerged.sha,
    codeMerged,
  });
  if (checks.kind === "moved") {
    return {
      end: failed(
        state,
        `postmerge verify checked ${checks.headSha}, not ${codeMerged.sha}; code remains merged`,
      ),
    };
  }
  if (checks.kind === "integrate") {
    return {
      end: failed(
        state,
        `postmerge checks failed on ${codeMerged.sha}; code remains merged, no code fix or push is allowed: ${checks.failing.map((check) => check.id).join(", ")}`,
      ),
    };
  }
  await ctx.save(checks.state);
  return { state: checks.state };
}

export type { LocalChecks };
export { checkedMergedResult, localChecks };
