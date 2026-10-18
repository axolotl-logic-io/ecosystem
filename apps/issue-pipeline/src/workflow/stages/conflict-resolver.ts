// The conflict resolver's sessions: a resolver
// for a rebase that stopped on conflicts, and a continuation on the same
// files, base and target when a resolver runs out of room and hands off, up
// to config maxContinuations (#269). The rebase stays in progress between
// them, and a continuation is not a conflict-fix attempt. The sweep launches
// them here; the finalizer role builds its own from resolverSession.

import type { Budgets } from "../budget.ts";
import { sessionBudget } from "../budget.ts";
import type { Committer, PromptItem } from "../prompts.ts";
import {
  commitOftenRule,
  committerText,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
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
  ModelRole,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// The repo config as the stages read it.
type StageConfig = StageContext["cfg"];

const DEFAULT_CONFLICT_FIXES = 2;
const RESOLVER_MINUTES = 45;
// What a resolver that runs out of room keeps of its work.
const KEEP_REBASE =
  "finish the rebase steps you can and commit what builds, but never run `git rebase --abort` and leave the rest of the rebase in progress";

// The most conflict resolutions an issue gets (config maxConflictFixes).
function maxConflictFixes(ctx: {
  cfg: Pick<StageConfig, "maxConflictFixes">;
}): number {
  return ctx.cfg.maxConflictFixes ?? DEFAULT_CONFLICT_FIXES;
}

// What a resolver's session is built from besides the issue: the repo's
// settings and how the session commits.
interface ResolverSettings {
  cfg: StageConfig;
  budgets: Budgets;
  models: Readonly<Record<ModelRole, string>>;
  committer: Committer;
}

// The resolver's run: the conflict, which conflict attempt it is, and, for a
// continuation, how many continuations the conflicts have had, or null for
// a first resolver.
interface ResolverRun {
  conflict: Conflict;
  attempt: number;
  continuation: number | null;
}

// The resolver session for `run` on `item`; a continuation starts from the
// handoff. Both the sweep's conflict resolution and the finalizer role run
// it.
function resolverSession(
  item: PromptItem,
  settings: ResolverSettings,
  run: ResolverRun,
): ChildLaunch {
  const { cfg, budgets, models, committer } = settings;
  const { conflict, attempt, continuation } = run;
  const { handoffFile } = item.paths;
  const role = `conflict resolver, attempt ${attempt} of ${maxConflictFixes(settings)}`;
  const lines = resolverTask(
    item,
    conflict.target,
    { base: cfg.baseBranch, files: conflict.files, baseSha: conflict.baseSha },
    committer,
  );
  lines.push(
    commitOftenRule(
      committerText(
        committer,
        "continue the rebase as soon as each stopped commit is resolved, and commit each fix after it on its own as soon as it works",
        "continue the rebase as soon as each stopped commit is resolved, and commit each fix after it on its own with `pipeline_commit` as soon as it works",
      ),
    ),
    NO_ARTIFICIAL_LOAD_RULE,
    handoffRule(budgets, handoffFile, KEEP_REBASE),
  );
  let name = `conflicts-${attempt}`;
  if (continuation !== null) {
    lines.unshift(handoffLead(handoffFile));
    name += `-c${continuation}`;
  }
  return {
    kind: "child",
    name,
    label: `Resolve rebase conflicts for issue ${item.n}`,
    agent: "issue-pipeline-writer",
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    writer: true,
    minutes: RESOLVER_MINUTES,
    budgetRole: "fixer",
    tokenBudget: sessionBudget(budgets, "fixer"),
    task: preamble(cfg, item, role).concat(lines).join("\n"),
  };
}

// The resolver for `conflict` on the sweep's `state`.
function resolverLaunch(
  state: StageState,
  ctx: StageContext,
  conflict: Conflict,
  continuation: boolean,
): ChildLaunch {
  let taken: number | null = null;
  if (continuation) {
    taken = continuationsOf(state.st, "conflicts");
  }
  return resolverSession(state, ctx, {
    conflict,
    attempt: state.st.conflictFixes ?? 0,
    continuation: taken,
  });
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

export type { ResolverRun, ResolverSettings };
export { conflicted, continueResolver, maxConflictFixes, resolverSession };
