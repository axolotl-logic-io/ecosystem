// Security's task result (#186): the read-only Security review of exactly R
// on T, run in the merge job as a tokenless, non-committing session, with
// its attempt recorded before the session and its verdict after, both by
// the landing account. A clearance saved before activation is never read
// as a result: with no Security result for the binding, the review runs
// afresh. Land then consumes the passed result (`least-privilege-per-task`:
// the run reads; a separate recorder persists its result).

import type { RoleContext } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { ReadyTask } from "../task-results.ts";
import {
  newRun,
  recordAttempt,
  recordResult,
  taskStatus,
} from "../task-results.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop } from "../writer-session.ts";
import { boundAs } from "./chain.ts";
import type { LandedResult } from "./security.ts";
import { securityReviewed } from "./security.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

type Verdict = "passed" | "failed" | "refused";

// The verdict a saved receipt in `state` gives exactly `revision`'s review,
// if it holds one.
function savedVerdict(
  state: IssueState,
  revision: LandedResult["revision"],
): Exclude<Verdict, "failed"> | null {
  const saved = state.security;
  if (
    saved === null ||
    !("phase" in saved) ||
    saved.phase !== "candidate" ||
    !sameRevision(saved.revision, revision)
  ) {
    return null;
  }
  if (saved.finding === null) {
    return "passed";
  }
  return "refused";
}

// The state with no clearance to reuse: a saved finding stays, since a
// rejection is never dropped, but a clearance from before this result's
// attempt grants nothing.
function withoutClearance(state: IssueState): IssueState {
  if (state.security === null || state.security.finding !== null) {
    return state;
  }
  return { ...state, security: null };
}

// One fresh review of `result`, as a new recorded attempt of `binding`.
async function freshAttempt(
  ctx: RoleContext,
  state: IssueState,
  { next, result }: { next: ReadyTask; result: LandedResult },
): Promise<Step<IssueState>> {
  const binding = boundAs(next, "Security");
  const run = newRun(await taskStatus(ctx, binding));
  await recordAttempt(ctx, binding, run);
  const reviewed = await securityReviewed(ctx, withoutClearance(state), result);
  let after = state;
  let summary = "the review ended without a verdict for this revision";
  if (reviewed.ok) {
    after = reviewed.value;
  } else if ("state" in reviewed.end) {
    after = reviewed.end.state;
    if ("reason" in reviewed.end) {
      summary = reviewed.end.reason;
    }
  }
  const verdict = savedVerdict(after, result.revision);
  if (verdict === null || (verdict === "passed" && !reviewed.ok)) {
    await recordResult(ctx, binding, {
      run: run.id,
      verdict: "failed",
      summary,
    });
    return reviewed;
  }
  await recordResult(ctx, binding, {
    run: run.id,
    verdict,
    summary: `Security reviewed ${short(result.revision.code)}: ${verdict}`,
  });
  return reviewed;
}

// The Security result for exactly `next`'s binding: reused when it passed,
// settled from the saved receipt when an interrupted run left it unknown,
// and otherwise a fresh recorded review.
async function securityTask(
  ctx: RoleContext,
  state: IssueState,
  args: { next: ReadyTask; result: LandedResult },
): Promise<Step<IssueState>> {
  const { next, result } = args;
  const binding = boundAs(next, "Security");
  const status = await taskStatus(ctx, binding);
  switch (status.status) {
    case "passed":
      return await securityReviewed(ctx, state, result);
    case "missing":
      return await freshAttempt(ctx, state, args);
    case "unknown": {
      const verdict = savedVerdict(state, result.revision);
      if (verdict === null) {
        return ended(
          errorStop(
            state,
            `Security run ${status.run} has no verdict and no saved receipt; a person must reconcile it`,
          ),
        );
      }
      await recordResult(ctx, binding, {
        run: status.run,
        verdict,
        summary: `reconciled from the saved receipt: ${verdict}`,
      });
      return await securityReviewed(ctx, state, result);
    }
    default:
      return ended(
        errorStop(
          state,
          `Security of ${short(result.revision.code)} is ${status.status}; it can't merge or complete`,
        ),
      );
  }
}

export { securityTask };
