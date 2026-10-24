// Lawd's read-only Integration task job (#186; `sync-is-a-task`): one run
// of a requested Integration binding, R on the exact target T, through the
// integration-task op (#185). The op checks R in a detached checkout no
// branch or push can reach and records the attempt and result through the
// landing account; the job runs no model, so it holds no session at all.
// This role only routes the op's answer:
//
//   passed (or passed before)   → back to merge, R's checks proven
//   checks failed or changed    → back to review: the Developer fixes them
//   no passed Hardening         → back to review for fresh Hardening
//   target moved or R misses T  → wait, requesting Sync of the fresh binding
//   an unsettled run, a hold    → stop for a person: an Integration without
//                                 a verdict is never read as a failure
//
// A passed Integration is R's premerge check proof (verifiedSha), so the
// merge stage never runs the suite again (`no-repeated-checks`).

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { TaskReport, TaskRequest } from "../../job/task-request.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply } from "../op-replies.ts";
import type { Run } from "../task-results.ts";
import { newRun, readiness, requestOf, taskStatus } from "../task-results.ts";
import { errorStop } from "../writer-session.ts";

const REPLY = z.object({
  route: z.enum([
    "sync-needed",
    "hardening-needed",
    "hold",
    "developer",
    "security",
  ]),
  reason: z.string(),
  verdict: z.enum(["passed", "failed"]).optional(),
});

type Reply = z.infer<typeof REPLY>;

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

function reportOf(
  request: TaskRequest,
  run: Run | null,
  verdict: TaskReport["verdict"],
): TaskReport {
  return { ...request, run, verdict };
}

function codeOf(request: TaskRequest): string | null {
  if ("revision" in request.binding) {
    return request.binding.revision.code;
  }
  return null;
}

// R's checks passed on T: the merge stage goes on with this proof.
function proved(
  state: IssueState,
  request: TaskRequest,
  task: TaskReport,
): RoleEnd {
  const code = codeOf(request);
  const proof = logged(
    { ...state, stage: "merge", verifiedSha: code },
    `Integration passed on ${short(code)} at ${short(request.binding.target.commit)}`,
  );
  return { kind: "next", state: proof, task };
}

// Back to review: the Developer's Hardening fixes the checks or hardens the
// revision afresh, producing the revision Integration checks next.
function toReview(state: IssueState, why: string, task: TaskReport): RoleEnd {
  const next: IssueState = {
    ...state,
    stage: "review",
    hardened: null,
    verifiedSha: null,
  };
  return { kind: "next", state: logged(next, `${why}; back to review`), task };
}

// The wait for the Sync a moved target needs, with its fresh binding.
async function syncRequested(
  ctx: RoleContext,
  why: string,
  task: TaskReport,
): Promise<RoleEnd> {
  const { next } = await readiness(ctx);
  let request: TaskRequest | null = null;
  if (next !== null) {
    request = requestOf(next);
  }
  if (next?.task === "Sync" && request !== null) {
    return {
      kind: "wait",
      reason: `${why}; Sync is requested`,
      state: ctx.state,
      request,
      task,
    };
  }
  return {
    kind: "wait",
    reason: `${why}; the next merge job reads the chain afresh`,
    state: ctx.state,
    task,
  };
}

// Where the op's answer for `run` sends the issue.
async function routed(
  ctx: RoleContext,
  request: TaskRequest,
  { run, reply }: { run: Run; reply: Reply },
): Promise<RoleEnd> {
  let recorded: Run | null = null;
  if (reply.verdict !== undefined) {
    recorded = run;
  }
  const verdict = reply.verdict ?? "refused";
  const task = reportOf(request, recorded, verdict);
  switch (reply.route) {
    case "security":
      return proved(ctx.state, request, task);
    case "developer": {
      // The Developer's Hardening fixes what Integration found, as a new
      // revision: the failure goes with it.
      const returned: IssueState = {
        ...ctx.state,
        mergeReturn: {
          reason: "retest",
          detail: reply.reason,
          codeMerged: false,
        },
      };
      return toReview(returned, `Integration: ${reply.reason}`, task);
    }
    case "hardening-needed":
      return toReview(ctx.state, `Integration: ${reply.reason}`, task);
    case "sync-needed":
      return await syncRequested(ctx, `Integration: ${reply.reason}`, task);
    default:
      return {
        ...errorStop(ctx.state, `Integration holds: ${reply.reason}`),
        task: reportOf(request, recorded, "held"),
      };
  }
}

const integrationRole: Role = async (ctx: RoleContext): Promise<RoleEnd> => {
  const request = ctx.task ?? null;
  if (request === null || request.task !== "Integration") {
    return errorStop(
      ctx.state,
      "an Integration job runs only a requested Integration binding",
    );
  }
  const status = await taskStatus(ctx, request.binding);
  switch (status.status) {
    case "passed": {
      const run = { id: status.result.run.id, previous: null };
      return proved(ctx.state, request, reportOf(request, run, "passed"));
    }
    case "missing": {
      const run = newRun(status);
      const reply = await opReply(
        ctx,
        "integration-task",
        { binding: request.binding, run },
        REPLY,
      );
      return await routed(ctx, request, { run, reply });
    }
    case "unknown":
      return {
        ...errorStop(
          ctx.state,
          `Integration run ${status.run} has no verdict; a person must reconcile it before another run`,
        ),
        task: reportOf(request, { id: status.run, previous: null }, "unknown"),
      };
    case "held":
      return {
        ...errorStop(ctx.state, `the task results are held: ${status.reason}`),
        task: reportOf(request, null, "held"),
      };
    default:
      return {
        ...errorStop(
          ctx.state,
          `Integration of this binding is ${status.status}; a person must decide`,
        ),
        task: reportOf(request, null, "held"),
      };
  }
};

export { integrationRole };
