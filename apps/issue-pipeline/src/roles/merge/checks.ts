// Exact-head checks used before integration and on actual merged results.
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import type { Check, Conflict } from "../op-replies.ts";
import { opReply, VERIFY_REPLY, WIKI_CHECK_REPLY } from "../op-replies.ts";
import { failed } from "./returns.ts";
import { rejectedAgain } from "./security.ts";

// What the merge job's local checks found: nothing to do, or what its own
// integration needs.
type LocalChecks =
  | { kind: "ready"; state: IssueState }
  | { kind: "integrate"; wikiConflict: Conflict | null; failing: Check[] }
  | { kind: "moved"; headSha: string };

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
  let codePassed = true;
  if (codeMerged !== null || state.verifiedSha !== code) {
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
      codePassed = false;
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
  if (!codePassed || failing.length > 0 || !wiki.pass) {
    return { kind: "integrate", wikiConflict: null, failing };
  }
  return { kind: "ready", state: checked };
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
