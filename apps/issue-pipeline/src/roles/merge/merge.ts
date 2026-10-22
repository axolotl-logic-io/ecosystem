// Serialized merge orchestration: exact hardening/checks and read-only Security
// precede deterministic mutation; result verification still follows it.

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import { reviewedTarget } from "../../reviewed-target.ts";
import type { IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply, readyPr } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { currentRevision } from "../revision-source.ts";
import { afterEarlierMerge, afterOwnMerge } from "./after-merge.ts";
import { localChecks } from "./checks.ts";
import { finishCompleted } from "./completion.ts";
import type { IntegrationNeed } from "./integration.ts";
import { integrate } from "./integration.ts";
import { MERGE_REPLY, recoverAttempt, recoverOwnMerge } from "./recovery.ts";
import { failed, toReview, waiting } from "./returns.ts";
import { rejectedAgain, securityReviewed } from "./security.ts";
import { approvalGate } from "./source.ts";

const CI_STATUS = z.union([
  z.looseObject({ status: z.enum(["pass", "pending", "head-changed"]) }),
  z.looseObject({ status: z.literal("no-checks") }),
  z.looseObject({ status: z.literal("fail"), failing: z.array(z.string()) }),
]);

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The checks before the merge, on the authorized head `code`: verify when
// this head isn't verified yet, and CI on exactly this head.
async function checksBeforeMerge(
  ctx: RoleContext,
  { code, pr }: { code: string; pr: number },
): Promise<{ state: IssueState } | { end: RoleEnd }> {
  const local = await localChecks(ctx, ctx.state, { code, codeMerged: null });
  if (local.kind === "moved") {
    return { end: toReview(ctx.state, "the code head moved before verify") };
  }
  if (local.kind === "integrate") {
    const need: IntegrationNeed = {
      rebase: false,
      failing: local.failing,
      why: "the authorized head's checks failed at merge",
    };
    return { end: await integrate(ctx, ctx.state, need) };
  }
  const { state } = local;
  const ci = await opReply(
    ctx,
    "ci-status",
    { pr, expectedSha: code },
    CI_STATUS,
  );
  switch (ci.status) {
    case "pass":
      return { state };
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
      const failing = ci.failing.map((id) => ({
        id: `ci: ${id}`,
        pass: false,
        detail: `the required CI check ${id} failed on ${code}`,
      }));
      const need: IntegrationNeed = {
        rebase: false,
        failing,
        why: `CI failed on ${short(code)}`,
      };
      return { end: await integrate(ctx, state, need) };
    }
    default:
      return { end: failed(state, "ci-status: unexpected status") };
  }
}

// What a refused merge means: wait for the queue, harden a moved head,
// integrate a moved base, mark a draft ready, or stop on GitHub's refusal.
async function refusedMerge(
  ctx: RoleContext,
  state: IssueState,
  reason: string,
): Promise<RoleEnd> {
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
      return await integrate(ctx, state, {
        rebase: true,
        failing: [],
        why: `the branch is ${reason} ${ctx.cfg.baseBranch}`,
      });
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

function mergeSummary(state: IssueState, authorized: Revision): string {
  return `Merged at code ${short(authorized.code)} and trusted inputs ${short(authorized.inputs)}; verified at ${short(state.verifiedSha)}; CI passed on that head.`;
}

async function clearedCandidate(
  ctx: RoleContext,
  current: CurrentRevision,
  code: string,
  pr: number,
): Promise<{ state: IssueState; authorized: Revision } | { end: RoleEnd }> {
  const checked = await checksBeforeMerge(ctx, { code, pr });
  if ("end" in checked) {
    return { end: checked.end };
  }
  const clearance = await securityReviewed(ctx, checked.state, {
    revision: current.revision,
    codeMerged: null,
    target: reviewedTarget(ctx.cfg, current.baseSha),
    still: (after: Revision): boolean => sameRevision(after, current.revision),
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
      end: await integrate(ctx, state, {
        rebase: true,
        failing: [],
        why: "the target moved after Security clearance",
      }),
    };
  }
  return { state, authorized: fresh.revision };
}

// The open PR's merge, at the authorized code head.
async function mergeCode(
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
  const cleared = await clearedCandidate(ctx, current, code, pr.number);
  if ("end" in cleared) {
    return cleared.end;
  }
  const { state, authorized } = cleared;
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
      summary: mergeSummary(state, authorized),
    },
    MERGE_REPLY,
  );
  if (!reply.merged) {
    return await refusedMerge(ctx, state, reply.reason);
  }
  if (reply.byHand === true) {
    return waiting(
      state,
      "the PR merged outside this confirmed operation; a fresh claim and existing postmerge authorization are required",
    );
  }
  if (reply.headSha !== code) {
    return toReview(
      state,
      `PR #${pr.number} merged at ${short(reply.headSha)}, not the authorized ${short(code)}`,
    );
  }
  return await afterOwnMerge(ctx, state, {
    authorized,
    mergeCommit: reply.mergeCommit,
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
  const recovered = await recoverOwnMerge(ctx, current);
  if (recovered !== null) {
    return recovered;
  }
  const gate = approvalGate(ctx, ctx.state, current);
  if (gate !== null) {
    return gate;
  }
  const { state } = ctx;
  if (state.codeMerged !== null) {
    return await afterEarlierMerge(ctx, current, state.codeMerged);
  }
  if (state.pr === null) {
    return failed(state, "the change has no PR to merge");
  }
  return await mergeCode(ctx, current);
};

export { mergeRole };
