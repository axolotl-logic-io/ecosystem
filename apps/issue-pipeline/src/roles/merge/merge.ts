// The merge stage (`deterministic-merge-and-publish`), the Reviewer's at the
// caller's serialized merge turn. It merges only the revision the merge
// authorization names (state.ts mergeAuthorization: the hardened revision,
// or the Reviewer's own checked integration of it), read fresh before each
// mutation:
//
// - a change to the trusted inputs goes to the author, and a code or wiki
//   head that moved by anything but the Reviewer's own integration goes
//   back to review, which hardens it;
// - a base or wiki that moved, a conflict and a failed check get the
//   Reviewer's own integration (integration.ts), in bounded writer
//   sessions, counted against `maxSyncs`, with no review of its own work;
// - otherwise the head is verified if it isn't yet, the wiki checked, CI
//   waited for on exactly that head, and the PR squash-merged in merge-queue
//   order with its head matched; then the receipt is saved, and the
//   read-only security review of the merged result decides whether the wiki
//   publishes and the issue completes (publish.ts, security.ts);
// - a done issue whose finish didn't finish only runs the finish op again,
//   once a security receipt approves exactly what merged.

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, Revision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply, readyPr } from "../op-replies.ts";
import type { CurrentRevision } from "../revision-source.ts";
import { currentRevision } from "../revision-source.ts";
import { finishCompleted } from "./completion.ts";
import type { IntegrationNeed } from "./integration.ts";
import { integrate } from "./integration.ts";
import { afterOwnMerge, localChecks, publishOnly } from "./publish.ts";
import { failed, toReview, waiting } from "./returns.ts";
import { approvalGate } from "./source.ts";

const CI_STATUS = z.union([
  z.looseObject({ status: z.enum(["pass", "pending", "head-changed"]) }),
  z.looseObject({ status: z.literal("no-checks") }),
  z.looseObject({ status: z.literal("fail"), failing: z.array(z.string()) }),
]);
const MERGE = z.union([
  z.looseObject({
    merged: z.literal(true),
    mergeCommit: z.string().min(1),
    headSha: z.string().min(1),
  }),
  z.looseObject({ merged: z.literal(false), reason: z.string().min(1) }),
]);

const CHECKS_ONLY = { code: false, wiki: false };

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

function integration(
  rebase: IntegrationNeed["rebase"],
  why: string,
): IntegrationNeed {
  return { rebase, wikiConflict: null, failing: [], why };
}

// The checks before the merge, on the authorized head `code`: verify when
// this head isn't verified yet, the wiki check, and CI on exactly this head.
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
      rebase: CHECKS_ONLY,
      wikiConflict: local.wikiConflict,
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
        rebase: CHECKS_ONLY,
        wikiConflict: null,
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
// integrate a moved base or wiki, mark a draft ready, or stop on GitHub's
// refusal.
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
    case "stale":
      return toReview(state, "the revision moved before the merge");
    case "wiki-missing":
      return failed(
        state,
        "the issue's wiki checkout doesn't hold the authorized wiki commit, so the merge refused to merge code whose wiki it can't publish",
      );
    case "wiki-behind":
      return await integrate(
        ctx,
        state,
        integration({ code: false, wiki: true }, "the wiki moved"),
      );
    case "behind":
    case "conflict":
      return await integrate(
        ctx,
        state,
        integration(
          { code: true, wiki: true },
          `the branch is ${reason} ${ctx.cfg.baseBranch}`,
        ),
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

function mergeSummary(state: IssueState, authorized: Revision): string {
  return `Merged at code ${short(authorized.code)}, wiki ${short(authorized.wiki)} and trusted inputs ${short(authorized.inputs)}; verified at ${short(state.verifiedSha)}; the wiki checked and CI passed on that head.`;
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
  const checked = await checksBeforeMerge(ctx, { code, pr: pr.number });
  if ("end" in checked) {
    return checked.end;
  }
  const { state } = checked;
  const fresh = await currentRevision(ctx);
  const gate = approvalGate(ctx, state, fresh);
  if (gate !== null) {
    return gate;
  }
  const authorized = fresh.revision;
  const reply = await opReply(
    ctx,
    "merge",
    {
      number: ctx.issue,
      state,
      expectedSha: code,
      revision: authorized,
      mergeQueue: ctx.mergeQueue,
      summary: mergeSummary(state, authorized),
    },
    MERGE,
  );
  if (!reply.merged) {
    return await refusedMerge(ctx, state, reply.reason);
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
  const current = await currentRevision(ctx);
  const gate = approvalGate(ctx, ctx.state, current);
  if (gate !== null) {
    return gate;
  }
  const { state } = ctx;
  if (state.codeMerged !== null) {
    return await publishOnly(ctx, current);
  }
  if (state.pr === null) {
    if (state.flows?.code === true) {
      return failed(state, "the change has code but no PR to merge");
    }
    return await publishOnly(ctx, current);
  }
  return await mergeCode(ctx, current);
};

export { mergeRole };
