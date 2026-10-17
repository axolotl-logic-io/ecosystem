// The CI fixer's sessions: a fixer for a check failure while the issue has
// CI-fix attempts left, and a continuation for the same failure
// when a fixer runs out of room and hands off, up to config maxContinuations
// (#269). A continuation is not a CI-fix attempt.

import { sessionBudget } from "../budget.ts";
import { practicesNote } from "../practices.ts";
import {
  beyondIssueRule,
  commitRulesOf,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
  preamble,
} from "../prompts.ts";
import { CIFIX_SCHEMA } from "../schemas.ts";
import type { IssueState } from "../types.ts";
import {
  continuationsOf,
  continued,
  mayContinue,
  outOfRoomReason,
} from "./continuation.ts";
import { isRecord } from "./reply-guards.ts";
import { launchStep, stopStep } from "./step.ts";
import type {
  ChildLaunch,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// The failure a fixer works on, and whether it continues from a handoff.
interface FixerJob {
  failure: string;
  continuation: boolean;
}

const FIXER_MINUTES = 60;

// The CI-fix attempt the issue is on; continuations don't count.
function attemptOf(state: StageState): number {
  return state.st.ciFixes ?? 0;
}

// The session's name: `cifix-<attempt>`, and `-c<k>` for its kth continuation.
function launchName(state: StageState, continuation: boolean): string {
  const name = `cifix-${attemptOf(state)}`;
  if (continuation) {
    return `${name}-c${continuationsOf(state.st, "ciFix")}`;
  }
  return name;
}

function fixerLaunch(
  state: StageState,
  ctx: StageContext,
  job: FixerJob,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const budget = sessionBudget(budgets, "ciFixer");
  const attempt = attemptOf(state);
  const role = `check fixer, attempt ${attempt} of ${cfg.maxCiFixes}`;
  const { handoffFile } = state.paths;
  const lines = [
    practicesNote(cfg, state, "writer"),
    "These checks failed:",
    job.failure,
    "",
    "Fix every failing check, whatever caused it, even when this change didn't: a flaky check is a failure, so fix its cause and never just re-run it. If `fails-before-fix` failed, the tests do not prove the change: strengthen them so they fail without the fix. If a lockfile check failed, regenerate the lockfile with the package manager.",
    ...commitRulesOf(ctx.committer, {
      unit: "step",
      when: "as soon as it works",
      trailer: "Pipeline-Agent: check fixer",
      clearMessage: false,
    }),
    `Run the failing check locally, commit what is left and leave the worktree clean. Return \`cannot-fix\` only for a failure no change in the repo can fix: an outage of an outside service, missing secrets or credentials, or anything that needs the repo's owner. Say which in \`summary\`.`,
    beyondIssueRule(cfg.baseBranch, "`summary`, which is posted on the PR"),
    NO_ARTIFICIAL_LOAD_RULE,
    handoffRule(budgets, handoffFile, "make it build and commit it"),
  ];
  if (job.continuation) {
    lines.unshift(handoffLead(handoffFile));
  }
  return {
    kind: "child",
    name: launchName(state, job.continuation),
    label: `Fix failing checks for issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    writer: true,
    minutes: FIXER_MINUTES,
    budgetRole: "ciFixer",
    tokenBudget: budget,
    task: preamble(cfg, state, role).concat(lines).join("\n"),
  };
}

// Launches a fixer session, after posting `comments`. The
// next phase, `fixed`, reads the failure back through `failureOf`; the rest
// of the stage's carry, such as checks' round count, is kept.
function launchFixer(
  state: StageState,
  ctx: StageContext,
  job: FixerJob,
  comments: readonly StageComment[],
): Step {
  let kept: Record<string, unknown> = {};
  if (isRecord(state.carry)) {
    kept = state.carry;
  }
  const carry = { ...kept, failure: job.failure };
  return launchStep(
    { ...state, phase: "fixed", carry },
    [fixerLaunch(state, ctx, job)],
    comments,
  );
}

// The failure the last fixer was launched for. `fixed` always follows a
// launch in the same sweep, so anything else is a bug in the sweep's loop.
function failureOf(state: StageState): string {
  const { carry } = state;
  if (isRecord(carry)) {
    const { failure } = carry;
    if (typeof failure === "string") {
      return failure;
    }
  }
  throw new Error("checks: the CI fixer's failure was not carried");
}

// Launches a fixer for `failure`, after posting `comments`, while the issue
// has CI-fix attempts left.
function startFix(
  state: StageState,
  ctx: StageContext,
  failure: string,
  comments: readonly StageComment[],
): Step {
  const { maxCiFixes } = ctx.cfg;
  if (attemptOf(state) >= maxCiFixes) {
    return stopStep(
      state,
      `checks still fail after ${maxCiFixes} CI-fix attempts`,
      failure,
      comments,
    );
  }
  const st: IssueState = { ...state.st };
  st.ciFixes = (st.ciFixes ?? 0) + 1;
  const job = { failure, continuation: false };
  return launchFixer({ ...state, st }, ctx, job, comments);
}

// A fixer that ran out of room, after posting `comment`: a continuation for
// the same failure while the cap allows, else the issue stops as too large.
function handedOff(
  state: StageState,
  ctx: StageContext,
  summary: string,
  comment: StageComment,
): Step {
  const { maxContinuations } = ctx.cfg;
  if (!mayContinue(state.st, ctx.cfg, "ciFix")) {
    return stopStep(
      state,
      outOfRoomReason("CI fixer", maxContinuations),
      `Latest handoff: ${state.paths.handoffFile}\n\n${summary}`,
      [comment],
    );
  }
  const st = continued(state.st, "ciFix");
  const job = { failure: failureOf(state), continuation: true };
  return launchFixer({ ...state, st }, ctx, job, [comment]);
}

export { attemptOf, handedOff, startFix };
