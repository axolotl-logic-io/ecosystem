// The merge stage's place in the task chain (#186): the legacy merge entry
// point as a safe adapter. It reads the next ready task fresh
// (task-readiness) and does only the work that's safely its own: read-only
// Security, Land and Completion. Anything else becomes an explicit request
// or a return, never a hidden writer:
//
//   no current Implementation    → back to review, which returns it
//   R doesn't contain T          → wait, requesting Sync (R, T)
//   no passed Hardening for R, T → back to review for fresh Hardening
//   no passed Integration        → wait, requesting Integration (R, T)
//   Integration passed           → its pass is R's premerge check proof
//
// A saved approval or clearance from before activation is never a result:
// only the records task-readiness reads say what passed.

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import type { Binding } from "../../task-result-records.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { CurrentRevision } from "../revision-source.ts";
import type { Readiness, ReadyTask } from "../task-results.ts";
import { readiness, requestOf } from "../task-results.ts";
import { errorStop } from "../writer-session.ts";
import { toReview, waiting } from "./returns.ts";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// What the merge job may go on to: Security or Land of exactly this
// binding, the state carrying Integration's check proof.
interface Cleared {
  state: IssueState;
  next: ReadyTask & { task: "Security" | "Land" };
}

// The wait that asks the caller for `next`'s task.
function requesting(state: IssueState, next: ReadyTask, why: string): RoleEnd {
  const request = requestOf(next);
  if (request === null) {
    return waiting(state, why);
  }
  return {
    kind: "wait",
    reason: `${why}; ${request.task} is requested`,
    state,
    request,
  };
}

// Where `ready` sends the merge of `current`, or what it may go on to.
function routed(
  state: IssueState,
  current: CurrentRevision,
  ready: Readiness,
): RoleEnd | Cleared {
  if (ready.next === null) {
    return errorStop(state, `the task chain is held: ${ready.hold}`);
  }
  const { next } = ready;
  const { code } = current.revision;
  if (ready.revision?.code !== code) {
    return waiting(
      state,
      `the branch reads ${short(ready.revision?.code ?? null)}, not ${short(code)}; the next merge job reads it afresh`,
    );
  }
  const at = `${short(code)} on ${short(ready.target.commit)}`;
  switch (next.task) {
    case "Implementation":
      return toReview(
        state,
        "no Implementation task result is current for today's requirements",
      );
    case "Sync":
      return requesting(
        state,
        next,
        `revision ${short(code)} doesn't contain the target ${short(ready.target.commit)}`,
      );
    case "Hardening":
      return toReview(
        state,
        `no passed Hardening task result holds for exactly ${at}; fresh Hardening is required`,
      );
    case "Integration":
      if (next.status === "unknown") {
        return errorStop(
          state,
          `Integration of ${at} has an attempt without a verdict; a person must reconcile it`,
        );
      }
      return requesting(state, next, `Integration of ${at} is ${next.status}`);
    case "Security":
    case "Land":
      return {
        state: withProof(state, code, at),
        next: { ...next, task: next.task },
      };
    default:
      return errorStop(
        state,
        `the chain reads ${next.task} for ${at}, which a merge job can't start`,
      );
  }
}

// Integration passed for exactly R on T: that pass is R's premerge check
// proof (verifiedSha), so no suite runs twice (`no-repeated-checks`).
function withProof(
  state: IssueState,
  code: string | null,
  at: string,
): IssueState {
  if (code === null || state.verifiedSha === code) {
    return state;
  }
  return withLog(
    { ...state, verifiedSha: code },
    `Integration passed on ${at}`,
    new Date(),
  );
}

// The merge's fresh route through the chain.
async function chainRoute(
  ctx: RoleContext,
  state: IssueState,
  current: CurrentRevision,
): Promise<RoleEnd | Cleared> {
  return routed(state, current, await readiness(ctx));
}

// The wait for the Sync a moved or conflicting target needs, read fresh, so
// the caller gets its exact binding; a plain wait when the chain reads
// otherwise.
async function syncNeeded(
  ctx: RoleContext,
  state: IssueState,
  why: string,
): Promise<RoleEnd> {
  const ready = await readiness(ctx);
  if (ready.next?.task === "Sync") {
    return requesting(state, ready.next, why);
  }
  return waiting(state, `${why}; the next merge job reads the chain afresh`);
}

// The binding of `task` for the same revision and target as `next`.
function boundAs(next: ReadyTask, task: "Security" | "Land"): Binding {
  const { binding } = next;
  if (!("revision" in binding)) {
    throw new Error(`the ${next.task} binding names no revision`);
  }
  return { ...binding, task };
}

export type { Cleared };
export { boundAs, chainRoute, syncNeeded };
