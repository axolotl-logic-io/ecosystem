// Hardening's task result (#186): what the review stage reads and records of
// the chain before and after the hardening session. A revision that misses
// the target goes to Sync first, so no session hardens work Sync replaces.
// A hardened checkpoint becomes a passed Hardening result for exactly the
// hardened revision R on the target T it was checked at, recorded by the
// landing account before the checkpoint is saved: Integration consumes it,
// and a saved checkpoint without one never counts as a result.

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import type { Binding } from "../../task-result-records.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { Readiness } from "../task-results.ts";
import {
  newRun,
  readiness,
  recordAttempt,
  recordResult,
  requestOf,
  taskStatus,
} from "../task-results.ts";
import { errorStop } from "../writer-session.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The wait for a Sync when R doesn't contain T, a stop when the chain is
// held, or null when the revision may be hardened.
function beforeHardening(state: IssueState, ready: Readiness): RoleEnd | null {
  if (ready.next === null) {
    return errorStop(state, `the task chain is held: ${ready.hold}`);
  }
  const request = requestOf(ready.next);
  if (ready.next.task === "Sync" && request !== null) {
    return {
      kind: "wait",
      reason: `revision ${short(ready.revision?.code ?? null)} doesn't contain target ${short(ready.target.commit)}; Sync it first, then harden the new revision`,
      state,
      request,
    };
  }
  return null;
}

// Whether a current Hardening result passed for exactly R on T.
function hardeningPassed(ready: Readiness): boolean {
  return (
    ready.next !== null &&
    ready.next.task !== "Sync" &&
    ready.next.task !== "Hardening"
  );
}

// Records the passed Hardening of `code` on `target`, read fresh: a new
// attempt and its result, or the result of an attempt an interrupted job
// left unsettled. Null once it is recorded; otherwise where the issue goes.
async function recordHardening(
  ctx: RoleContext,
  state: IssueState,
  { code, target }: { code: string; target: string },
): Promise<RoleEnd | null> {
  const ready = await readiness(ctx);
  if (ready.revision?.code !== code || ready.target.commit !== target) {
    return {
      kind: "wait",
      reason: `the branch or target moved after hardening ${short(code)} on ${short(target)}; the next job hardens afresh`,
      state,
    };
  }
  const { inputs, policy } = ready.revision;
  const binding: Binding = {
    repo: ctx.cfg.repo,
    workItem: ctx.issue,
    task: "Hardening",
    revision: { code, inputs, policy },
    target: { branch: ready.target.branch, commit: target },
  };
  const status = await taskStatus(ctx, binding);
  const summary = `hardened ${code} on ${target}; the pipeline's checks passed on it`;
  switch (status.status) {
    case "passed":
      return null;
    case "unknown":
      await recordResult(ctx, binding, {
        run: status.run,
        verdict: "passed",
        summary,
      });
      return null;
    case "missing": {
      const run = newRun(status);
      await recordAttempt(ctx, binding, run);
      await recordResult(ctx, binding, {
        run: run.id,
        verdict: "passed",
        summary,
      });
      return null;
    }
    default:
      return errorStop(
        state,
        `Hardening of ${short(code)} on ${short(target)} is ${status.status}; a person must reconcile its records`,
      );
  }
}

export { beforeHardening, hardeningPassed, recordHardening };
