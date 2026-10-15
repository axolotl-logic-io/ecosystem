// Sync's conflict resolution: a writer finishes a rebase that stopped on
// conflicts, the rebase is finished or aborted, and the resolver's reply
// decides whether the issue moves to checks, retries next sweep or stops.

import { chargeSession } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { preamble } from "../prompts.ts";
import { CIFIX_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import { byStep } from "../signing.ts";
import type { IssueState } from "../types.ts";
import type { FixOutput } from "./checks-reply.ts";
import {
  finishReplyOf,
  fixOf,
  fixOutputOf,
  isRecord,
  isStrings,
} from "./checks-reply.ts";
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

// What sync keeps between its steps: the conflicting files, and once the
// resolver has replied, its reply (null when it failed), signature and error.
interface SyncMemo {
  files: string[];
  fix: FixOutput | null;
  by: Signature;
  error: string | null;
}

// The resolver's comment and the conflicting files, as the outcome reads them.
interface Outcome {
  comment: StageComment;
  files: readonly string[];
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function signatureOf(value: unknown): Signature | null {
  if (!isRecord(value)) {
    return null;
  }
  const { role, agent, model, run } = value;
  if (
    typeof role !== "string" ||
    !nullableText(agent) ||
    !nullableText(model) ||
    !nullableText(run)
  ) {
    return null;
  }
  return { role, agent, model, run };
}

// What sync carries between its steps; anything else is a bug in the sweep's loop.
function memoOf(state: StageState): SyncMemo {
  const { carry } = state;
  if (isRecord(carry)) {
    const { files, fix, by, error } = carry;
    const signature = signatureOf(by);
    if (isStrings(files) && signature !== null && nullableText(error)) {
      return { files, fix: fixOf(fix), by: signature, error };
    }
  }
  throw new Error("sync: expected the conflicting files");
}

function filesOf(state: StageState): string[] {
  const { carry } = state;
  if (isRecord(carry)) {
    const { files } = carry;
    if (isStrings(files)) {
      return files;
    }
  }
  throw new Error("sync: expected the conflicting files");
}
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
  files: readonly string[],
  baseSha: unknown,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const base = cfg.baseBranch;
  const attempt = state.st.conflictFixes ?? 0;
  const role = `conflict resolver, attempt ${attempt} of ${maxConflictFixes(ctx)}`;
  const lines = [
    `The pipeline is rebasing this branch onto origin/${base} (${String(baseSha).slice(0, SHORT_SHA)}), and the rebase stopped on conflicts in:`,
    files.map((file) => `- ${file}`).join("\n"),
    "",
    `Finish the rebase. For each stopped commit, read what ${base} changed in the conflicting files (\`git log -p ORIG_HEAD..origin/${base} -- <file>\` or \`git diff <merge-base> origin/${base} -- <file>\`) and what this branch changed, and write a resolution that keeps the intent of both. Then \`git add\` the files and run \`GIT_EDITOR=true git rebase --continue\`; repeat if a later commit stops too.`,
    `Code that merged without a textual conflict can still break: ${base} may use a name or field this branch renamed or removed. After the rebase finishes, run the repo's type check and the unit tests for the touched areas, and fix what broke in a new commit ending with the trailer line \`Pipeline-Agent: conflict resolver\`. The pipeline runs the full checks afterwards.`,
    `Never run \`git rebase --abort\`, \`git reset\` to another commit, or \`git push\`. Leave the rebase finished and the worktree clean. No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what ${base} now does and re-apply this branch's change on top of it as far as it still makes sense, and say in your summary what you chose. Return \`cannot-fix\` only if you could not finish the rebase at all; a fresh resolver then tries again next sweep.`,
  ];
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

// The rebase stopped on conflicts; a writer finishes it. Its resolution
// changes the code, so every check runs again.
function conflicted(
  state: StageState,
  ctx: StageContext,
  files: string[],
  baseSha: unknown,
): Step {
  const st: IssueState = { ...state.st };
  st.testsOnly = false;
  st.passedSha = null;
  st.conflictFixes = (st.conflictFixes ?? 0) + 1;
  const counted = { ...state, st };
  const charge = chargeSession(ctx.budgets, st, "fixer");
  if (!charge.charged) {
    return stopStep(counted, "issue token budget exhausted", charge.detail);
  }
  return launchStep({ ...counted, phase: "resolved", carry: { files } }, [
    resolverLaunch(counted, ctx, files, baseSha),
  ]);
}
// Finishes the rebase, or aborts it when the resolver couldn't. The
// resolver's comment waits for the next step, after the finish.
function resolved(state: StageState, results: readonly LaunchResult[]): Step {
  const result = onlyChild(results);
  const files = filesOf(state);
  const fix = fixOutputOf(result);
  const abort = fix === null || fix.status === "cannot-fix";
  const reason = fix?.summary ?? "the conflict resolver failed";
  const memo: SyncMemo = { files, fix, by: result.by, error: result.error };
  return launchStep({ ...state, phase: "finished", carry: memo }, [
    {
      kind: "op",
      name: "finish-sync",
      op: "finish-sync",
      payload: { number: state.n, abort, reason },
    },
  ]);
}

function resolverComment(
  state: StageState,
  ctx: StageContext,
  memo: SyncMemo,
  fix: FixOutput,
): StageComment {
  const role = `conflict resolver (attempt ${state.st.conflictFixes ?? 0})`;
  let lead = "";
  if (fix.status === "cannot-fix") {
    lead = `I couldn't resolve the conflicts with ${ctx.cfg.baseBranch}: `;
  }
  return prComment({ ...memo.by, role }, lead + fix.summary);
}

// A rejected resolution stops the issue on its last attempt; otherwise the
// issue stays at sync and the next sweep rebases again.
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

function rebased(
  state: StageState,
  ctx: StageContext,
  headSha: string,
  outcome: Outcome,
): Step {
  const { comment, files } = outcome;
  const base = ctx.cfg.baseBranch;
  const { st } = state;
  st.syncs = (st.syncs ?? 0) + 1;
  noteEvent(st, `resolved conflicts with ${base} and rebased`, ctx.now());
  const named = files.map((file) => `\`${file}\``).join(", ");
  const syncComment = prComment(
    byStep("sync"),
    `Rebased onto ${base} after resolving conflicts in ${named}; the head is now ${headSha.slice(0, SHORT_SHA)}. Every check runs again on it.`,
  );
  st.headSha = headSha;
  st.stage = "checks";
  return doneStep(state, [comment, syncComment]);
}

// Acts on the resolver's reply and the finished rebase. Conflicts never wait
// for a human (Autumn, 2026-10-13): a fresh resolver tries again next sweep,
// against a base that may have moved, until the budget runs out.
function finished(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = finishReplyOf(onlyReply(results));
  const memo = memoOf(state);
  const { fix, files } = memo;
  if (fix === null) {
    return stopStep(
      state,
      "the conflict-resolver session failed",
      `${fileListOf(files)}\n\n${memo.error ?? ""}`,
    );
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
    return doneStep(copied, [comment]);
  }
  if (reply.kind === "failed") {
    return stopStep(
      state,
      "could not finish the rebase after resolving conflicts",
      reply.error,
      [comment],
    );
  }
  if (reply.kind === "rejected") {
    return rejected(copied, ctx, reply.reason, { comment, files });
  }
  return rebased(copied, ctx, reply.headSha, { comment, files });
}

export { conflicted, finished, maxConflictFixes, resolved };
