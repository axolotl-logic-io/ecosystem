// A CI fix, as checks runs one after a failure: a writer (ci-fixer.ts) fixes
// the failing checks, the fix is pushed, and the correctness and scope lenses
// review just its diff before the state is saved for the next round.

import { sessionBudget } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { findingLines } from "../findings.ts";
import { LENSES } from "../lenses.ts";
import { preamble } from "../prompts.ts";
import { REVIEW_SCHEMA } from "../review-schemas.ts";
import type { IssueState, ListedFinding } from "../types.ts";
import { blockingOf, fixOutputOf, preparedOf } from "./checks-reply.ts";
import { attemptOf, handedOff } from "./ci-fixer.ts";
import {
  rateLimitedIn,
  rateLimitStep,
  sessionFailedStep,
} from "./rate-limit.ts";
import { isRecord, patchIdIn } from "./reply-guards.ts";
import { prepareLaunch } from "./stacked.ts";
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
const REVIEW_MINUTES = 20;
const SHORT_SHA = 12;

function headOf(state: StageState): string {
  return (state.st.headSha ?? "").slice(0, SHORT_SHA);
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
    const reason = "the check-fixer session failed";
    return sessionFailedStep(state, reason, result.error, ctx.now());
  }
  const attempt = attemptOf(state);
  const by = { ...result.by, role: `check fixer (attempt ${attempt})` };
  const { status, summary } = fix;
  switch (status) {
    case "cannot-fix":
      return stopStep(
        state,
        "the check fixer can't fix the failing checks from the repo",
        summary,
        [
          {
            by,
            body: `I can't fix this from the branch: ${summary}`,
            where: "pr",
          },
        ],
      );
    case "handoff":
      return handedOff(state, ctx, summary, {
        by,
        body: `I ran out of room before finishing; another session continues from my handoff. ${summary}`,
        where: "pr",
      });
    case "fixed":
      break;
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
  const st: IssueState = { ...state.st };
  noteEvent(st, `check fix ${attempt}: ${summary}`, ctx.now());
  return launchStep(
    { ...state, st, phase: "pushed" },
    [{ kind: "op", name: "push", op: "push", payload: { number: state.n } }],
    [{ by, body: summary, where: "pr" }],
  );
}

// Prepares the pushed check fix's diff for review. A check fix changes code,
// so acceptance and the security review run again.
function prepareFix(state: StageState): Step {
  const st = { ...state.st, testsOnly: false };
  const fields = { sinceSha: st.reviewedSha, tag: `cifix${attemptOf(state)}` };
  return launchStep({ ...state, st, phase: "prepared" }, [
    prepareLaunch(state, fields),
  ]);
}

function lensLaunch(
  state: StageState,
  ctx: StageContext,
  lens: FixLens,
  diffPath: string,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const budget = sessionBudget(budgets, "rereviewer");
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
    budgetRole: "rereviewer",
    tokenBudget: budget,
    task: preamble(cfg, state, role).concat(lines).join("\n"),
  };
}

// A check fix changes reviewed code, so the correctness and scope lenses look
// at just its diff. The carry keeps the patch id the diff's reply named, for
// the review to record.
function prepared(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const replied = onlyReply(results);
  const reply = preparedOf(replied);
  if (reply.kind === "failed") {
    return stopStep(state, "could not prepare the check-fix diff", reply.error);
  }
  let kept: Readonly<Record<string, unknown>> = {};
  if (isRecord(state.carry)) {
    kept = state.carry;
  }
  const carry = { ...kept, patchId: patchIdIn(replied) };
  return launchStep({ ...state, phase: "reviewed", carry }, [
    lensLaunch(state, ctx, "correctness", reply.value),
    lensLaunch(state, ctx, "scope", reply.value),
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
// finding in lens order, or saves the reviewed head. A reviewer that hit a
// transient provider error defers the issue to review instead: the pushed fix
// still needs its review, and checks alone would pass it on without one.
function reviewed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  if (rateLimitedIn(results)) {
    const st = { ...state.st, stage: "review" };
    const why = "a check-fix reviewer failed";
    return rateLimitStep({ ...state, st }, why, ctx.now());
  }
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
  st.reviewedPatchId = patchIdIn(state.carry);
  const payload = { number: state.n, state: st };
  return launchStep(
    { ...state, st, phase: "saved" },
    [{ kind: "op", name: "save", op: "save-state", payload }],
    comments,
  );
}

export { fixed, prepared, prepareFix, reviewed };
