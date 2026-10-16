// Conflict resolution: a writer finishes a rebase that stopped on conflicts,
// the rebase is finished or aborted, and the resolver's reply decides whether
// the issue moves on, retries next sweep or stops. Sync resolves its code
// rebase this way and moves to checks; merge and publish resolve the wiki's
// rebase and then carry on with their own next step (conflict-target.ts).

import { chargeSession } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { preamble } from "../prompts.ts";
import { CIFIX_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import { byStep } from "../signing.ts";
import type { IssueState } from "../types.ts";
import type { FixOutput } from "./checks-reply.ts";
import { finishReplyOf, fixOutputOf } from "./checks-reply.ts";
import type { Conflict, ConflictMemo } from "./conflict-memo.ts";
import { carriedOf, memoOf } from "./conflict-memo.ts";
import type { ConflictTarget } from "./conflict-target.ts";
import { finishOp, ontoText, resolverTask } from "./conflict-target.ts";
import {
  doneStep,
  launchStep,
  onlyChild,
  onlyReply,
  stopStep,
} from "./step.ts";
import type {
  ChildLaunch,
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

const DEFAULT_CONFLICT_FIXES = 2;
const RESOLVER_MINUTES = 45;
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

function maxConflictFixes(ctx: StageContext): number {
  return ctx.cfg.maxConflictFixes ?? DEFAULT_CONFLICT_FIXES;
}
function prComment(by: Signature, body: string): StageComment {
  return { by, body, where: "pr" };
}
function fileListOf(files: readonly string[]): string {
  return `Conflicting files:\n${files.join("\n")}`;
}

function resolverLaunch(
  state: StageState,
  ctx: StageContext,
  conflict: Conflict,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const attempt = state.st.conflictFixes ?? 0;
  const role = `conflict resolver, attempt ${attempt} of ${maxConflictFixes(ctx)}`;
  const lines = resolverTask(state, conflict.target, {
    base: cfg.baseBranch,
    files: conflict.files,
    baseSha: conflict.baseSha,
  });
  return {
    kind: "child",
    name: `conflicts-${attempt}`,
    label: `Resolve rebase conflicts for issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    writer: true,
    minutes: RESOLVER_MINUTES,
    task: preamble(cfg, state, role, budgets.roles.fixer)
      .concat(lines)
      .join("\n"),
  };
}

// The rebase stopped on conflicts; a writer finishes it. A resolution of the
// code changes it, so every check runs again; one of the wiki leaves the
// code's checks standing.
function conflicted(
  state: StageState,
  ctx: StageContext,
  conflict: Conflict,
): Step {
  const st: IssueState = { ...state.st };
  if (conflict.target.kind === "code") {
    st.testsOnly = false;
    st.passedSha = null;
  }
  st.conflictFixes = (st.conflictFixes ?? 0) + 1;
  const counted = { ...state, st };
  const charge = chargeSession(ctx.budgets, st, "fixer", {
    at: ctx.now(),
    pool: "rebase",
  });
  if (!charge.charged) {
    return stopStep(counted, charge.reason, charge.detail);
  }
  const { files, target } = conflict;
  const carry = { files, target };
  return launchStep({ ...counted, phase: "resolved", carry }, [
    resolverLaunch(counted, ctx, conflict),
  ]);
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

// Finishes the rebase, or aborts it when the resolver couldn't. The
// resolver's comment waits for the next step, after the finish.
function resolved(state: StageState, results: readonly LaunchResult[]): Step {
  const result = onlyChild(results);
  const { files, target } = carriedOf(state);
  const fix = fixOutputOf(result);
  const abort = fix === null || fix.status === "cannot-fix";
  const reason = fix?.summary ?? "the conflict resolver failed";
  const memo: ConflictMemo = {
    files,
    target,
    fix,
    by: result.by,
    error: result.error,
  };
  const op = finishOp(target);
  return launchStep({ ...state, phase: "finished", carry: memo }, [
    { kind: "op", name: op, op, payload: { number: state.n, abort, reason } },
  ]);
}

function resolverComment(
  state: StageState,
  ctx: StageContext,
  memo: ConflictMemo,
  fix: FixOutput,
): StageComment {
  const role = `conflict resolver (attempt ${state.st.conflictFixes ?? 0})`;
  let lead = "";
  if (fix.status === "cannot-fix") {
    lead = `I couldn't resolve the conflicts with ${ontoText(memo.target, ctx.cfg.baseBranch)}: `;
  }
  return prComment({ ...memo.by, role }, lead + fix.summary);
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
// against a base that may have moved, until the budget runs out.
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

// Sync's code rebase is finished: every check runs again on the new head.
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
  return doneStep(settled.state, [comment, syncComment]);
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
export {
  conflicted,
  finished,
  finishedWiki,
  maxConflictFixes,
  resolved,
  wikiConflicted,
};
