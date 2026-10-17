// The conflict resolver's sessions: a resolver
// for a rebase that stopped on conflicts, and a continuation on the same
// files, base and target when a resolver runs out of room and hands off, up
// to config maxContinuations (#269). The rebase stays in progress between
// them, and a continuation is not a conflict-fix attempt.

import { sessionBudget } from "../budget.ts";
import {
  commitOftenRule,
  handoffLead,
  handoffRule,
  preamble,
} from "../prompts.ts";
import { CIFIX_SCHEMA } from "../schemas.ts";
import type { IssueState } from "../types.ts";
import type { Conflict } from "./conflict-memo.ts";
import { conflictOf } from "./conflict-memo.ts";
import { resolverTask } from "./conflict-target.ts";
import { continuationsOf, continued } from "./continuation.ts";
import { launchStep } from "./step.ts";
import type {
  ChildLaunch,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

const DEFAULT_CONFLICT_FIXES = 2;
const RESOLVER_MINUTES = 45;
// What a resolver that runs out of room keeps of its work.
const KEEP_REBASE =
  "finish the rebase steps you can and commit what builds, but never run `git rebase --abort` and leave the rest of the rebase in progress";

function maxConflictFixes(ctx: StageContext): number {
  return ctx.cfg.maxConflictFixes ?? DEFAULT_CONFLICT_FIXES;
}

// The resolver for `conflict`; a continuation starts from the handoff.
function resolverLaunch(
  state: StageState,
  ctx: StageContext,
  conflict: Conflict,
  continuation: boolean,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const budget = sessionBudget(budgets, "fixer");
  const { handoffFile } = state.paths;
  const attempt = state.st.conflictFixes ?? 0;
  const role = `conflict resolver, attempt ${attempt} of ${maxConflictFixes(ctx)}`;
  const lines = resolverTask(state, conflict.target, {
    base: cfg.baseBranch,
    files: conflict.files,
    baseSha: conflict.baseSha,
  });
  lines.push(
    commitOftenRule(
      "continue the rebase as soon as each stopped commit is resolved, and commit each fix after it on its own as soon as it works",
    ),
    handoffRule(budgets, handoffFile, KEEP_REBASE),
  );
  let name = `conflicts-${attempt}`;
  if (continuation) {
    lines.unshift(handoffLead(handoffFile));
    name += `-c${continuationsOf(state.st, "conflicts")}`;
  }
  return {
    kind: "child",
    name,
    label: `Resolve rebase conflicts for issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    writer: true,
    minutes: RESOLVER_MINUTES,
    budgetRole: "fixer",
    tokenBudget: budget,
    task: preamble(cfg, state, role).concat(lines).join("\n"),
  };
}

// Launches a resolver on `conflict`; its
// reply comes back at phase `resolved`. `handedOff` is the comment of the
// resolver it continues from, posted first, or null for a first resolver.
function launchResolver(
  state: StageState,
  ctx: StageContext,
  conflict: Conflict,
  handedOff: StageComment | null,
): Step {
  const comments: StageComment[] = [];
  if (handedOff !== null) {
    comments.push(handedOff);
  }
  const { files, target, baseSha } = conflict;
  const carry = { files, target, baseSha };
  return launchStep(
    { ...state, phase: "resolved", carry },
    [resolverLaunch(state, ctx, conflict, handedOff !== null)],
    comments,
  );
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
  return launchResolver({ ...state, st }, ctx, conflict, null);
}

// A continuation of the resolver that handed off, after posting `comment`,
// on the same rebase, which is still in progress.
function continueResolver(
  state: StageState,
  ctx: StageContext,
  comment: StageComment,
): Step {
  const st = continued(state.st, "conflicts");
  return launchResolver({ ...state, st }, ctx, conflictOf(state), comment);
}

export { conflicted, continueResolver, maxConflictFixes };
