// The merge stage (`deterministic-merge-and-publish`): code only, with no
// model session, since its job holds the merge credentials. It merges only
// the exact revision the reviewer approved, read fresh before each mutation:
//
// - a change to the trusted inputs goes to the author, and a new code or
//   wiki head, the merge job's own clean rebase included, goes to review;
// - a conflict or a failed check goes to implement, counted against
//   `maxSyncs`;
// - otherwise the wiki is rebased and checked, the head verified if it isn't
//   yet, CI waited for, and the PR squash-merged in merge-queue order with
//   its head matched; then the receipt is saved, the reviewed wiki
//   published and the issue finished;
// - a done issue whose finish didn't finish only runs the finish op again.

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, Revision } from "../../state.ts";
import {
  afterOwnMerge,
  finishCompleted,
  publishOnly,
  wikiReady,
} from "./publish.ts";
import {
  counted,
  failed,
  implementWith,
  toImplement,
  toReview,
  waiting,
} from "./returns.ts";
import type { CurrentRevision } from "./source.ts";
import { approvalGate, currentRevision, opReply } from "./source.ts";
import { verifyHead } from "./verify.ts";

const SHORT_SHA_LENGTH = 12;

const CI_STATUS = z.union([
  z.looseObject({ status: z.enum(["pass", "pending", "head-changed"]) }),
  z.looseObject({ status: z.literal("no-checks") }),
  z.looseObject({ status: z.literal("fail"), failing: z.array(z.string()) }),
]);
const MERGE = z.union([
  z.looseObject({ merged: z.literal(true), mergeCommit: z.string().min(1) }),
  z.looseObject({ merged: z.literal(false), reason: z.string().min(1) }),
]);
const SYNC = z.union([
  z.looseObject({
    conflict: z.literal(false),
    changed: z.boolean(),
    headSha: z.string(),
  }),
  z.looseObject({ conflict: z.literal(true), conflicts: z.array(z.string()) }),
]);

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA_LENGTH) ?? "none";
}

// The merge found the branch behind its base, or conflicting with it: rebase
// it, counted as one sync, and verify the new head, which then goes to
// review, never straight to merge.
async function rebaseOntoBase(
  ctx: RoleContext,
  start: IssueState,
): Promise<RoleEnd> {
  const bound = counted(ctx, start, "sync");
  if ("stop" in bound) {
    return bound.stop;
  }
  let { state } = bound;
  const sync = await opReply(ctx, "sync-base", {}, SYNC);
  if (sync.conflict) {
    const detail = `rebasing onto ${ctx.cfg.baseBranch} conflicted in ${sync.conflicts.join(", ")}`;
    return implementWith(state, "conflict", detail);
  }
  if (!sync.changed) {
    return waiting(
      state,
      "the merge found the branch behind its base, but the rebase found it up to date",
    );
  }
  state = { ...state, headSha: sync.headSha };
  const check = await verifyHead(ctx, state, {
    expected: sync.headSha,
    payload: {},
  });
  if (check.kind === "moved") {
    return toReview(state, "the code head moved after the rebase");
  }
  if (check.kind === "failed") {
    return implementWith(state, "retest", check.detail);
  }
  const why = `rebased cleanly onto ${ctx.cfg.baseBranch} as ${short(sync.headSha)} and verified`;
  return toReview(check.state, why);
}

// The checks before the merge, on the approved head `code`: the wiki, verify
// when this head isn't verified yet, and CI. The state records the verify.
async function checksBeforeMerge(
  ctx: RoleContext,
  current: CurrentRevision,
  { code, pr }: { code: string; pr: number },
): Promise<{ state: IssueState } | { end: RoleEnd }> {
  let { state } = ctx;
  const wiki = await wikiReady(ctx, state, current);
  if (wiki !== null) {
    return { end: wiki };
  }
  if (state.verifiedSha !== code) {
    const check = await verifyHead(ctx, state, { expected: code, payload: {} });
    if (check.kind === "moved") {
      return { end: toReview(state, "the code head moved before verify") };
    }
    if (check.kind === "failed") {
      return { end: toImplement(ctx, state, "retest", check.detail) };
    }
    ({ state } = check);
  }
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
      return { end: waiting(state, "CI is still running on the head") };
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
    case "fail":
      return {
        end: toImplement(ctx, state, "ci", `failing: ${ci.failing.join(", ")}`),
      };
    default:
      return { end: failed(state, "ci-status: unexpected status") };
  }
}

function mergeSummary(state: IssueState, revision: Revision): string {
  return `Approved in review at code ${short(revision.code)}, wiki ${short(revision.wiki)} and trusted inputs ${short(revision.inputs)}; verified at ${short(state.verifiedSha)}; CI passed.`;
}

// What a refused merge means: wait for the queue, review a moved head,
// rebase onto a moved base, or stop on GitHub's refusal.
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
    case "wiki-behind":
      return waiting(
        state,
        "the wiki moved since its rebase; the next merge job rebases it again",
      );
    case "behind":
    case "conflict":
      return await rebaseOntoBase(ctx, state);
    default:
      return {
        kind: "stop",
        code: "merge-refused",
        reason: `GitHub refused the merge: ${reason}`,
        state,
      };
  }
}

// The open PR's merge, at the approved code head.
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
  const checked = await checksBeforeMerge(ctx, current, {
    code,
    pr: pr.number,
  });
  if ("end" in checked) {
    return checked.end;
  }
  const { state } = checked;
  const fresh = await currentRevision(ctx);
  const gate = approvalGate(ctx, state, fresh);
  if (gate !== null) {
    return gate;
  }
  const approved = fresh.revision;
  const reply = await opReply(
    ctx,
    "merge",
    {
      state,
      expectedSha: code,
      revision: approved,
      mergeQueue: ctx.mergeQueue,
      summary: mergeSummary(state, approved),
    },
    MERGE,
  );
  if (!reply.merged) {
    return await refusedMerge(ctx, state, reply.reason);
  }
  const { mergeCommit } = reply;
  return await afterOwnMerge(ctx, state, { approved, mergeCommit });
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
