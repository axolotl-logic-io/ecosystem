// Conflict resolution: a writer finishes a rebase that stopped on conflicts,
// the rebase is finished or aborted, and the resolver's reply decides whether
// the issue moves on, retries next sweep or stops. Sync resolves its code
// rebase this way and moves to checks; merge and publish resolve the wiki's
// rebase and then carry on with their own next step (conflict-target.ts). A
// resolver that runs out of room hands off to a continuation on the rebase
// still in progress (conflict-resolver.ts), up to config maxContinuations.

import { noteEvent } from "../event-log.ts";
import type { Signature } from "../signing.ts";
import { byStep } from "../signing.ts";
import type { FixOutput } from "./checks-reply.ts";
import { finishReplyOf, fixOutputOf } from "./checks-reply.ts";
import type { ConflictMemo } from "./conflict-memo.ts";
import { carriedOf, memoOf } from "./conflict-memo.ts";
import {
  conflicted,
  continueResolver,
  maxConflictFixes,
} from "./conflict-resolver.ts";
import type { ConflictTarget } from "./conflict-target.ts";
import { finishOp, ontoText } from "./conflict-target.ts";
import { mayContinue, outOfRoomReason } from "./continuation.ts";
import { flowEnd } from "./flow-step.ts";
import {
  doneStep,
  launchStep,
  onlyChild,
  onlyReply,
  stopStep,
} from "./step.ts";
import type {
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

const SHORT_SHA = 12;

// The resolver's comment and the conflicting files, as the outcome reads them.
interface Outcome {
  comment: StageComment;
  files: readonly string[];
}

// How a stage carries on once its wiki rebase is resolved: its next step,
// after posting `comments`.
type Resume = (state: StageState, comments: readonly StageComment[]) => Step;

// A finished resolution: a step that ends it, or the rebased head.
type Settled =
  | { kind: "step"; step: Step }
  | { kind: "rebased"; state: StageState; headSha: string; outcome: Outcome };

function prComment(by: Signature, body: string): StageComment {
  return { by, body, where: "pr" };
}
function fileListOf(files: readonly string[]): string {
  return `Conflicting files:\n${files.join("\n")}`;
}

// The wiki's rebase onto its `branch` stopped on conflicts: a writer resolves
// them while the issue has conflict attempts left, and the issue stops once
// they have run out.
function wikiConflicted(
  state: StageState,
  ctx: StageContext,
  conflict: { files: string[]; baseSha: unknown; branch: string },
): Step {
  const max = maxConflictFixes(ctx);
  const { files, baseSha, branch } = conflict;
  if ((state.st.conflictFixes ?? 0) >= max) {
    return stopStep(
      state,
      `rebasing the wiki onto ${branch} conflicts again after ${max} resolutions`,
      fileListOf(files),
    );
  }
  const target: ConflictTarget = { kind: "wiki", branch };
  return conflicted(state, ctx, { files, baseSha, target });
}

// Finishes the rebase, or aborts it when the resolver couldn't or ran out of
// room with no continuation left. A resolver that handed off below the cap
// gets a continuation on the rebase still in progress. Otherwise the
// resolver's comment waits for the next step, after the finish.
function resolved(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  const { files, target } = carriedOf(state);
  const fix = fixOutputOf(result);
  const memo: ConflictMemo = {
    files,
    target,
    fix,
    by: result.by,
    error: result.error,
  };
  if (
    fix?.status === "handoff" &&
    mayContinue(state.st, ctx.cfg, "conflicts")
  ) {
    return continueResolver(state, ctx, resolverComment(state, ctx, memo, fix));
  }
  const abort = fix === null || fix.status !== "fixed";
  const reason = fix?.summary ?? "the conflict resolver failed";
  const op = finishOp(target);
  return launchStep({ ...state, phase: "finished", carry: memo }, [
    { kind: "op", name: op, op, payload: { number: state.n, abort, reason } },
  ]);
}

// How the resolver's comment begins, by its status.
function leadOf(ctx: StageContext, memo: ConflictMemo, fix: FixOutput): string {
  const { status } = fix;
  switch (status) {
    case "fixed":
      return "";
    case "cannot-fix":
      return `I couldn't resolve the conflicts with ${ontoText(memo.target, ctx.cfg.baseBranch)}: `;
    case "handoff":
      return "I ran out of room before finishing the rebase: ";
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function resolverComment(
  state: StageState,
  ctx: StageContext,
  memo: ConflictMemo,
  fix: FixOutput,
): StageComment {
  const role = `conflict resolver (attempt ${state.st.conflictFixes ?? 0})`;
  return prComment({ ...memo.by, role }, leadOf(ctx, memo, fix) + fix.summary);
}

// A rejected resolution stops the issue on its last attempt; otherwise the
// issue stays at its stage and the next sweep rebases again.
function rejected(
  state: StageState,
  ctx: StageContext,
  reason: string,
  outcome: Outcome,
): Step {
  const { st } = state;
  const { comment } = outcome;
  if ((st.conflictFixes ?? 0) >= maxConflictFixes(ctx)) {
    return stopStep(
      state,
      "the conflict resolution was rejected",
      `${fileListOf(outcome.files)}\n\n${reason}`,
      [comment],
    );
  }
  noteEvent(
    st,
    `conflict resolution rejected: ${reason}; will retry next sweep`,
    ctx.now(),
  );
  return doneStep(state, [comment]);
}

// Acts on the resolver's reply and the finished rebase. Conflicts never wait
// for a human (Autumn, 2026-10-13): a fresh resolver tries again next sweep,
// against a base that may have moved, until the budget runs out. The one
// exception is a resolver that ran out of room with no continuation left: the
// rebase was aborted, and the issue stops as too large.
function settle(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Settled {
  const reply = finishReplyOf(onlyReply(results));
  const memo = memoOf(state);
  const { fix, files } = memo;
  if (fix === null) {
    const detail = `${fileListOf(files)}\n\n${memo.error ?? ""}`;
    const why = "the conflict-resolver session failed";
    return { kind: "step", step: stopStep(state, why, detail) };
  }
  const comment = resolverComment(state, ctx, memo, fix);
  // A copy for the steps below, which log to it.
  const copied = { ...state, st: { ...state.st } };
  if (fix.status === "cannot-fix") {
    noteEvent(
      copied.st,
      `conflict resolver found no resolution: ${fix.summary}; will retry next sweep`,
      ctx.now(),
    );
    return { kind: "step", step: doneStep(copied, [comment]) };
  }
  if (fix.status === "handoff") {
    const step = stopStep(
      state,
      outOfRoomReason("conflict resolver", ctx.cfg.maxContinuations),
      `${fileListOf(files)}\n\nLatest handoff: ${state.paths.handoffFile}\n\n${fix.summary}`,
      [comment],
    );
    return { kind: "step", step };
  }
  if (reply.kind === "failed") {
    const why = "could not finish the rebase after resolving conflicts";
    const step = stopStep(state, why, reply.error, [comment]);
    return { kind: "step", step };
  }
  const outcome = { comment, files };
  if (reply.kind === "rejected") {
    const step = rejected(copied, ctx, reply.reason, outcome);
    return { kind: "step", step };
  }
  return { kind: "rebased", state: copied, headSha: reply.headSha, outcome };
}

// Sync's code rebase is finished: its flows are acted on (flow-step.ts, sync's
// "flowed" phase), and every check runs again on the new head.
function finished(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const settled = settle(state, ctx, results);
  if (settled.kind === "step") {
    return settled.step;
  }
  const { comment, files } = settled.outcome;
  const { headSha } = settled;
  const base = ctx.cfg.baseBranch;
  const { st } = settled.state;
  st.syncs = (st.syncs ?? 0) + 1;
  noteEvent(st, `resolved conflicts with ${base} and rebased`, ctx.now());
  const named = files.map((file) => `\`${file}\``).join(", ");
  const syncComment = prComment(
    byStep("sync"),
    `Rebased onto ${base} after resolving conflicts in ${named}; the head is now ${headSha.slice(0, SHORT_SHA)}. Every check runs again on it.`,
  );
  st.headSha = headSha;
  st.stage = "checks";
  const comments = [comment, syncComment];
  return flowEnd(settled.state, ctx, onlyReply(results), comments);
}

// The wiki's rebase is finished: the stage carries on through `resume`. The
// code is unchanged, so its checks stand and no sync is counted.
function finishedWiki(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
  resume: Resume,
): Step {
  const settled = settle(state, ctx, results);
  if (settled.kind === "step") {
    return settled.step;
  }
  const { st } = settled.state;
  const onto = ontoText(memoOf(state).target, ctx.cfg.baseBranch);
  noteEvent(st, `resolved the wiki's conflicts with ${onto}`, ctx.now());
  return resume(settled.state, [settled.outcome.comment]);
}

export type { Resume };
export { finished, finishedWiki, resolved, wikiConflicted };
