// A CI fix, as checks runs one after a failure: a writer fixes the failing
// checks, the fix is pushed, and the correctness and scope lenses review just
// its diff before the state is saved for the next round.

import { chargeSession } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { findingLines } from "../findings.ts";
import { LENSES } from "../lenses.ts";
import { practicesNote, preamble } from "../prompts.ts";
import { REVIEW_SCHEMA } from "../review-schemas.ts";
import { CIFIX_SCHEMA } from "../schemas.ts";
import type { IssueState, ListedFinding } from "../types.ts";
import {
  blockingOf,
  fixOutputOf,
  preparedOf,
  pushedOf,
} from "./checks-reply.ts";
import { launchStep, onlyChild, onlyReply, stopStep } from "./step.ts";
import type {
  ChildLaunch,
  ChildResult,
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  StageStop,
  Step,
} from "./types.ts";

// The lenses that review a check fix, in the order they report.
type FixLens = "correctness" | "scope";

const FIX_LENSES: readonly FixLens[] = ["correctness", "scope"];
const FIXER_MINUTES = 60;
const REVIEW_MINUTES = 20;
const SHORT_SHA = 12;

function attemptOf(state: StageState): number {
  return state.st.ciFixes ?? 0;
}

function headOf(state: StageState): string {
  return (state.st.headSha ?? "").slice(0, SHORT_SHA);
}

function fixerLaunch(
  state: StageState,
  ctx: StageContext,
  failure: string,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const attempt = attemptOf(state);
  const role = `check fixer, attempt ${attempt} of ${cfg.maxCiFixes}`;
  const lines = [
    practicesNote(cfg, state, "writer"),
    "These checks failed:",
    failure,
    "",
    "Find the cause and fix it with the smallest change. If `fails-before-fix` failed, the tests do not prove the change: strengthen them so they fail without the fix. If a lockfile check failed, regenerate the lockfile with the package manager.",
    `Run the failing check locally, then commit (\`git add -A && git commit\`, ending each message with the trailer line \`Pipeline-Agent: check fixer\`) and leave the worktree clean. Return \`cannot-fix\` if the failure is unrelated to this change (for example, a flaky or broken check on ${cfg.baseBranch}).`,
  ];
  return {
    kind: "child",
    name: `cifix-${attempt}`,
    label: `Fix failing checks for issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    writer: true,
    minutes: FIXER_MINUTES,
    task: preamble(cfg, state, role, budgets.roles.ciFixer)
      .concat(lines)
      .join("\n"),
  };
}

// Launches a fixer for `failure`, after posting `comments`, while the issue
// has CI-fix attempts and budget left.
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
  const charge = chargeSession(ctx.budgets, st, "ciFixer", {
    at: ctx.now(),
  });
  if (!charge.charged) {
    return stopStep(state, charge.reason, charge.detail, comments);
  }
  st.ciFixes = (st.ciFixes ?? 0) + 1;
  const counted = { ...state, st };
  return launchStep(
    { ...counted, phase: "fixed" },
    [fixerLaunch(counted, ctx, failure)],
    comments,
  );
}

// Pushes the fix, or stops when the fixer failed or can't fix the checks.
function fixed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  const fix = fixOutputOf(result);
  if (fix === null) {
    return stopStep(state, "the check-fixer session failed", result.error);
  }
  const attempt = attemptOf(state);
  let lead = "";
  if (fix.status === "cannot-fix") {
    lead = "I can't fix this from the branch: ";
  }
  const comment: StageComment = {
    by: { ...result.by, role: `check fixer (attempt ${attempt})` },
    body: lead + fix.summary,
    where: "pr",
  };
  if (fix.status === "cannot-fix") {
    return stopStep(
      state,
      "the failing checks look unrelated to this change",
      fix.summary,
      [comment],
    );
  }
  const st: IssueState = { ...state.st };
  noteEvent(st, `check fix ${attempt}: ${fix.summary}`, ctx.now());
  return launchStep(
    { ...state, st, phase: "pushed" },
    [{ kind: "op", name: "push", op: "push", payload: { number: state.n } }],
    [comment],
  );
}

// Records the pushed head, then prepares the fix's diff for review. A check
// fix changes code, so acceptance and the security review run again.
function pushed(state: StageState, results: readonly LaunchResult[]): Step {
  const reply = pushedOf(onlyReply(results));
  if (reply.kind === "failed") {
    return stopStep(state, "could not push the check fix", reply.error);
  }
  const st: IssueState = { ...state.st };
  st.headSha = reply.value;
  st.testsOnly = false;
  const payload = {
    number: state.n,
    sinceSha: st.reviewedSha,
    tag: `cifix${attemptOf(state)}`,
  };
  return launchStep({ ...state, st, phase: "prepared" }, [
    { kind: "op", name: "prep", op: "prepare-review", payload },
  ]);
}

function lensLaunch(
  state: StageState,
  ctx: StageContext,
  lens: FixLens,
  diffPath: string,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const role = `check-fix reviewer (${lens})`;
  const lines = [
    `Concern: ${LENSES[lens]}`,
    `Review only the diff at ${diffPath}, which fixed failing checks after the PR passed review. Report only blocking defects this diff introduced. Do not edit files.`,
  ];
  return {
    kind: "child",
    name: `cifix-review-${lens}-${attemptOf(state)}`,
    label: `Review ${lens} of check fix for issue ${state.n}`,
    agent: "issue-pipeline-reader",
    model: models[lens],
    schema: REVIEW_SCHEMA,
    minutes: REVIEW_MINUTES,
    task: preamble(cfg, state, role, budgets.roles.rereviewer)
      .concat(lines)
      .join("\n"),
  };
}

// A check fix changes reviewed code, so the correctness and scope lenses look
// at just its diff.
function prepared(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = preparedOf(onlyReply(results));
  if (reply.kind === "failed") {
    return stopStep(state, "could not prepare the check-fix diff", reply.error);
  }
  const st: IssueState = { ...state.st };
  const charged = { ...state, st };
  const charge = chargeSession(ctx.budgets, st, "rereviewer", {
    at: ctx.now(),
    count: FIX_LENSES.length,
  });
  if (!charge.charged) {
    return stopStep(state, charge.reason, charge.detail);
  }
  return launchStep({ ...charged, phase: "reviewed" }, [
    lensLaunch(charged, ctx, "correctness", reply.value),
    lensLaunch(charged, ctx, "scope", reply.value),
  ]);
}

function lensResult(
  results: readonly LaunchResult[],
  index: number,
): ChildResult {
  const result = results[index];
  if (results.length !== FIX_LENSES.length || result?.kind !== "child") {
    throw new Error("checks: expected the results of the check-fix reviews");
  }
  return result;
}

function blockingDetail(blocking: readonly ListedFinding[]): string {
  return blocking
    .map((f) => `${f.file}:${f.line} ${f.title} - ${f.evidence}`)
    .join("\n");
}

function reviewBody(
  state: StageState,
  blocking: readonly ListedFinding[],
): string {
  let found = "No blocking findings.";
  if (blocking.length > 0) {
    found = `**Blocking**\n\n${findingLines(blocking)}`;
  }
  return `Review of the check fix in ${headOf(state)}.\n\n${found}`;
}

// Posts every lens's comment, then stops on the first failure or blocking
// finding in lens order, or saves the reviewed head.
function reviewed(state: StageState, results: readonly LaunchResult[]): Step {
  const comments: StageComment[] = [];
  const stops: StageStop[] = [];
  FIX_LENSES.forEach((lens, index) => {
    const result = lensResult(results, index);
    const blocking = blockingOf(result);
    if (blocking === null) {
      stops.push({
        reason: "a check-fix reviewer failed",
        detail: result.error,
        code: null,
      });
      return;
    }
    const role = `check-fix reviewer (${lens})`;
    const body = reviewBody(state, blocking);
    comments.push({ by: { ...result.by, role }, body, where: "pr" });
    if (blocking.length > 0) {
      const reason = "the check fix introduced a blocking problem";
      stops.push({ reason, detail: blockingDetail(blocking), code: null });
    }
  });
  const [stop] = stops;
  if (stop !== undefined) {
    return stopStep(state, stop.reason, stop.detail, comments);
  }
  const st: IssueState = { ...state.st };
  st.reviewedSha = st.headSha ?? null;
  const payload = { number: state.n, state: st };
  return launchStep(
    { ...state, st, phase: "saved" },
    [{ kind: "op", name: "save", op: "save-state", payload }],
    comments,
  );
}

export { fixed, prepared, pushed, reviewed, startFix };
