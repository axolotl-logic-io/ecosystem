// Serialized Land orchestration, as the legacy merge entry point's safe
// adapter (#186): the next ready task is read fresh (chain.ts), and the job
// does only read-only Security, Land and Completion itself. A moved target
// requests Sync, missing Integration requests Integration, and a failed
// check or a missing Hardening result returns to review. It never runs a
// writer: no hidden Sync, no check fix.

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import { reviewedTarget } from "../../reviewed-target.ts";
import type { IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply, readyPr } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { currentRevision } from "../revision-source.ts";
import { newRun, taskStatus } from "../task-results.ts";
import { afterEarlierLand, afterOwnLand } from "./after-land.ts";
import type { Cleared } from "./chain.ts";
import { boundAs, chainRoute, syncNeeded } from "./chain.ts";
import { finishCompleted } from "./completion.ts";
import { MERGE_REPLY, recoverAttempt, recoverOwnLand } from "./recovery.ts";
import { failed, toReview, waiting } from "./returns.ts";
import { rejectedAgain } from "./security.ts";
import { securityTask } from "./security-task.ts";
import { approvalGate } from "./source.ts";

const CI_STATUS = z.union([
  z.looseObject({ status: z.enum(["pass", "pending", "head-changed"]) }),
  z.looseObject({ status: z.literal("no-checks") }),
  z.looseObject({ status: z.literal("fail"), failing: z.array(z.string()) }),
]);

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The checks before the Land, on the authorized head `code`: Integration's
// recorded pass for exactly this revision and target (chain.ts), then CI on
// exactly this head. A failure goes back to the Developer's Hardening, which
// fixes it as a new revision; the merge job fixes nothing itself.
async function checksBeforeLand(
  ctx: RoleContext,
  { code, pr, current }: { code: string; pr: number; current: CurrentRevision },
): Promise<{ cleared: Cleared } | { end: RoleEnd }> {
  const route = await chainRoute(ctx, ctx.state, current);
  if ("kind" in route) {
    return { end: route };
  }
  const { state } = route;
  if (state !== ctx.state) {
    await ctx.save(state);
  }
  const ci = await opReply(
    ctx,
    "ci-status",
    { pr, expectedSha: code },
    CI_STATUS,
  );
  switch (ci.status) {
    case "pass":
      return { cleared: route };
    case "pending":
      return {
        end: waiting(state, `CI is still running on ${short(code)}`),
      };
    case "head-changed":
      return { end: toReview(state, "the PR head moved during CI") };
    case "no-checks":
      return {
        end: {
          kind: "stop",
          code: "no-ci",
          reason: `the config requires CI, and PR #${pr} has no required CI checks`,
          state,
        },
      };
    case "fail": {
      const detail = `The required CI checks ${ci.failing.join(", ")} failed on ${code}.`;
      const returned: IssueState = {
        ...state,
        mergeReturn: { reason: "ci", detail, codeMerged: false },
      };
      return {
        end: toReview(
          returned,
          `the required CI checks ${ci.failing.join(", ")} failed on ${short(code)}; the Developer fixes them as a new revision`,
        ),
      };
    }
    default:
      return { end: failed(state, "ci-status: unexpected status") };
  }
}

// What a refused Land means: wait for the queue, harden a moved head,
// request Sync for a moved base, mark a draft ready, or stop on GitHub's
// refusal.
async function refusedLand(
  ctx: RoleContext,
  state: IssueState,
  reply: { reason: string; detail?: unknown },
): Promise<RoleEnd> {
  const { reason } = reply;
  switch (reason) {
    case "queued":
      return waiting(state, "the merge waits for its turn in the merge queue");
    case "head-changed":
      return toReview(state, "the PR head moved before the merge");
    case "target-changed":
      return toReview(
        state,
        "the reviewed target changed; fresh checks and review are required",
      );
    case "stale":
      return toReview(state, "the revision moved before the merge");
    case "behind":
    case "conflict":
      return await syncNeeded(
        ctx,
        state,
        `the branch is ${reason} ${ctx.cfg.baseBranch}`,
      );
    case "task-results":
      return waiting(
        state,
        `Land's task results don't hold: ${String(reply.detail)}; the next merge job reads the chain afresh`,
      );
    case "integration-turn":
      return waiting(
        state,
        `the Land waits for the target: ${String(reply.detail)}`,
      );
    case "draft": {
      // An interrupted job left the PR a draft; the saved state is the
      // authorization ready-pr checks.
      await ctx.save(state);
      await readyPr(ctx, state);
      return waiting(state, "the PR was still a draft; it is marked ready now");
    }
    default:
      return {
        kind: "stop",
        code: "merge-refused",
        reason: `GitHub refused the merge: ${reason}`,
        state,
      };
  }
}

function landSummary(state: IssueState, authorized: Revision): string {
  return `Merged at code ${short(authorized.code)} and trusted inputs ${short(authorized.inputs)}; verified at ${short(state.verifiedSha)}; CI passed on that head.`;
}

interface Candidate {
  state: IssueState;
  authorized: Revision;
  cleared: Cleared;
}

async function clearedCandidate(
  ctx: RoleContext,
  current: CurrentRevision,
  code: string,
  pr: number,
): Promise<Candidate | { end: RoleEnd }> {
  const checked = await checksBeforeLand(ctx, { code, pr, current });
  if ("end" in checked) {
    return { end: checked.end };
  }
  const clearance = await securityTask(ctx, checked.cleared.state, {
    next: checked.cleared.next,
    result: {
      revision: current.revision,
      codeMerged: null,
      target: reviewedTarget(ctx.cfg, current.baseSha),
      still: (after: Revision): boolean =>
        sameRevision(after, current.revision),
    },
  });
  if (!clearance.ok) {
    return { end: clearance.end };
  }
  const state = clearance.value;
  const fresh = await currentRevision(ctx);
  const gate = approvalGate(ctx, state, fresh);
  if (gate !== null) {
    return { end: gate };
  }
  if (fresh.baseSha !== current.baseSha) {
    return {
      end: await syncNeeded(
        ctx,
        state,
        "the target moved after Security clearance",
      ),
    };
  }
  return { state, authorized: fresh.revision, cleared: checked.cleared };
}

// The open PR's landing, at the authorized code head, as an exact Land of the
// chain's binding: a new run of it, linked to its latest attempt.
async function landCode(
  ctx: RoleContext,
  current: CurrentRevision,
): Promise<RoleEnd> {
  const { pr } = current;
  const { code } = current.revision;
  if (pr === null || code === null) {
    return failed(ctx.state, "the change has code but no PR to merge");
  }
  if (pr.state === "MERGED") {
    return waiting(
      ctx.state,
      `PR #${pr.number} merged outside this job; the next claim confirms the merge`,
    );
  }
  if (pr.state !== "OPEN") {
    return failed(ctx.state, `PR #${pr.number} is ${pr.state}`);
  }
  const candidate = await clearedCandidate(ctx, current, code, pr.number);
  if ("end" in candidate) {
    return candidate.end;
  }
  const { state, authorized, cleared } = candidate;
  const binding = boundAs(cleared.next, "Land");
  const landRun = newRun(await taskStatus(ctx, binding));
  const reply = await opReply(
    ctx,
    "merge",
    {
      number: ctx.issue,
      state,
      expectedSha: code,
      expectedBase: current.baseSha,
      revision: authorized,
      mergeQueue: ctx.mergeQueue,
      summary: landSummary(state, authorized),
      binding,
      landRun,
    },
    MERGE_REPLY,
  );
  if (!reply.merged) {
    return await refusedLand(ctx, state, reply);
  }
  if (reply.byHand === true) {
    return waiting(
      state,
      "the PR merged outside this confirmed operation; a fresh claim reconciles it read-only",
    );
  }
  if (reply.headSha !== code) {
    return toReview(
      state,
      `PR #${pr.number} merged at ${short(reply.headSha)}, not the authorized ${short(code)}`,
    );
  }
  return await afterOwnLand(ctx, state, {
    authorized,
    mergeCommit: reply.mergeCommit,
    land: binding,
  });
}

const mergeRole: Role = async (ctx: RoleContext): Promise<RoleEnd> => {
  const { merged } = ctx.state;
  if (ctx.state.stage === "done" && merged !== null) {
    return await finishCompleted(ctx, ctx.state, merged);
  }
  const attempt = await recoverAttempt(ctx);
  if (attempt !== null) {
    return attempt;
  }
  const current = await currentRevision(ctx);
  const rejected = rejectedAgain(ctx.state, current.revision);
  if (rejected !== null) {
    return rejected;
  }
  const recovered = await recoverOwnLand(ctx, current);
  if (recovered !== null) {
    return recovered;
  }
  // Before the approval gate, so a stop retains the landed result's evidence.
  if (ctx.state.codeMerged !== null) {
    return afterEarlierLand(ctx.state, ctx.state.codeMerged);
  }
  const gate = approvalGate(ctx, ctx.state, current);
  if (gate !== null) {
    return gate;
  }
  const { state } = ctx;
  if (state.pr === null) {
    return failed(state, "the change has no PR to merge");
  }
  return await landCode(ctx, current);
};

export { mergeRole };
