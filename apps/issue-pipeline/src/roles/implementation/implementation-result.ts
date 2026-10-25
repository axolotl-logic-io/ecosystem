// Implementation's task result (#118): once the Developer's push lands, the
// job's recorder, the landing account, records a passed Implementation for
// the requirements the session worked from, on the target read fresh, naming
// the pushed revision R as what it produced. It's recorded before saved state
// moves to review, so Hardening never starts on work no result vouches for
// (`requirements-bindings`; task-readiness holds it otherwise).

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import type { Binding } from "../../task-result-records.ts";
import { requirementsDigest } from "../../task-result-records.ts";
import { SHORT_SHA } from "../change-task.ts";
import {
  newRun,
  readiness,
  recordAttempt,
  recordResult,
  taskStatus,
} from "../task-results.ts";
import { errorStop } from "../writer-session.ts";

function short(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

// Records the passed Implementation that produced `code`: a new attempt and
// its result, or the result of an attempt an interrupted job left unsettled.
// Null once it's recorded, or when the requirements changed during the
// session, which review sends back to their owner; otherwise where the issue
// goes.
async function recordImplementation(
  ctx: RoleContext,
  state: IssueState,
  code: string,
): Promise<RoleEnd | null> {
  const ready = await readiness(ctx);
  if (ready.revision?.code !== code) {
    return {
      kind: "wait",
      reason: `the branch moved after the Developer pushed ${short(code)}; the next Implementation reads it afresh`,
      state,
    };
  }
  if (ready.revision.inputs !== ctx.inputs.revision) {
    return null;
  }
  const binding: Binding = {
    repo: ctx.cfg.repo,
    workItem: ctx.issue,
    task: "Implementation",
    requirements: requirementsDigest(ctx.inputs.revision),
    target: ready.target,
  };
  const status = await taskStatus(ctx, binding);
  const result = {
    verdict: "passed" as const,
    summary: `implemented the requirements as ${code} on ${ready.target.commit}`,
    produced: code,
  };
  switch (status.status) {
    case "passed":
      return null;
    case "unknown":
      await recordResult(ctx, binding, { ...result, run: status.run });
      return null;
    case "missing": {
      const run = newRun(status);
      await recordAttempt(ctx, binding, run);
      await recordResult(ctx, binding, { ...result, run: run.id });
      return null;
    }
    default:
      return errorStop(
        state,
        `Implementation of ${short(code)} is ${status.status}; a person must reconcile its records`,
      );
  }
}

export { recordImplementation };
