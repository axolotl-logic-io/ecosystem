// Review: the first review of the PR. Three reviewers each read the diff
// through one lens; their blocking findings are merged by the aggregator and
// numbered for the fixer. A clean review moves the issue to sync, one with
// blocking findings to fix.

import { chargeSession } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { addFinding } from "../findings.ts";
import type { ReviewLens } from "../lenses.ts";
import { LENS_NAMES } from "../lenses.ts";
import { AGG_SCHEMA, REVIEW_SCHEMA } from "../review-schemas.ts";
import { byStep } from "../signing.ts";
import type { Finding } from "../types.ts";
import type {
  MergedFinding,
  RawFinding,
  ReviewFinding,
} from "./review-replies.ts";
import {
  mergedFindingsOf,
  rawFindingsOf,
  reviewFindingsOf,
} from "./review-replies.ts";
import type { ReviewDiff } from "./review-text.ts";
import {
  aggregateTask,
  findingIdsComment,
  lensComment,
  lensTask,
} from "./review-text.ts";
import {
  copyState,
  doneStep,
  launchEach,
  launchStep,
  onlyChild,
  onlyReply,
  prComment,
  replyError,
  saveStep,
  sessionsOf,
  stopStep,
} from "./step.ts";
import type {
  ChildLaunch,
  ChildResult,
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where the review is: about to prepare the diff, launching the reviewers,
// reading their findings, reading the aggregator's, or waiting for the save.
type ReviewPhase = "begin" | "prepared" | "reviewed" | "aggregated" | "saved";

const PHASES: readonly ReviewPhase[] = [
  "begin",
  "prepared",
  "reviewed",
  "aggregated",
  "saved",
];

const REVIEW_MINUTES = 25;
const AGGREGATE_MINUTES = 10;

function phaseOf(state: StageState): ReviewPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`review: unknown phase ${state.phase}`);
  }
  return phase;
}

// Charges the three reviewers, then prepares the diff.
function begin(state: StageState, ctx: StageContext): Step {
  const st = copyState(state.st);
  const charged = { ...state, st };
  const charge = chargeSession(ctx.budgets, st, "reviewer", {
    at: ctx.now(),
    count: LENS_NAMES.length,
  });
  if (!charge.charged) {
    return stopStep(charged, charge.reason, charge.detail);
  }
  const payload = { number: state.n, tag: "r0" };
  return launchStep({ ...charged, phase: "prepared" }, [
    { kind: "op", name: "prep", op: "prepare-review", payload },
  ]);
}

function lensLaunch(
  ctx: StageContext,
  state: StageState,
  lens: ReviewLens,
  diff: ReviewDiff,
): ChildLaunch {
  return {
    kind: "child",
    name: `review-${lens}`,
    label: `Review ${lens} of issue ${state.n}`,
    agent: "issue-pipeline-reader",
    model: ctx.models[lens],
    schema: REVIEW_SCHEMA,
    minutes: REVIEW_MINUTES,
    task: lensTask(ctx, state, lens, diff),
  };
}

// Starts the review afresh on the prepared head, and launches the reviewers.
function prepared(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const { ok, error, headSha, diffPath, diffLines } = onlyReply(results);
  if (ok !== true || typeof headSha !== "string") {
    return stopStep(
      state,
      "could not prepare the review diff",
      replyError(error),
    );
  }
  const st = { ...state.st, headSha, findings: [], round: 0 };
  const started = { ...state, st, phase: "reviewed" };
  const diff = { path: String(diffPath), lines: String(diffLines) };
  return launchEach(
    started,
    LENS_NAMES.map((lens) => lensLaunch(ctx, started, lens, diff)),
  );
}

// What the reviewers said: each one's comment, the blocking findings with
// their lens, and the first failure.
interface Reviews {
  comments: StageComment[];
  raw: RawFinding[];
  failed: string | null;
}

function readReviews(
  state: StageState,
  sessions: readonly { name: ReviewLens; result: ChildResult }[],
): Reviews {
  const reviews: Reviews = { comments: [], raw: [], failed: null };
  const headSha = state.st.headSha ?? "";
  for (const { name: lens, result } of sessions) {
    let findings: ReviewFinding[] | null = null;
    if (result.ok) {
      findings = reviewFindingsOf(result.structuredOutput);
    }
    if (findings === null) {
      reviews.failed ??= `${lens} reviewer failed: ${result.error ?? "no output"}`;
    } else {
      readReview(reviews, { lens, result, headSha }, findings);
    }
  }
  return reviews;
}

// A reviewer that replied: its blocking findings and its signed comment.
function readReview(
  reviews: Reviews,
  {
    lens,
    result,
    headSha,
  }: { lens: ReviewLens; result: ChildResult; headSha: string },
  findings: readonly ReviewFinding[],
): void {
  const blocking = findings.filter((f) => f.severity === "blocking");
  const nits = findings.filter((f) => f.severity !== "blocking");
  reviews.raw.push(...blocking.map((f) => ({ lens, ...f })));
  // Each reviewer signs its own comment, so the PR shows which lens said what.
  const by = { ...result.by, role: `reviewer (${lens})` };
  reviews.comments.push(
    prComment(by, lensComment(headSha, lens, blocking, nits)),
  );
}

function aggregateLaunch(
  ctx: StageContext,
  state: StageState,
  raw: readonly RawFinding[],
): ChildLaunch {
  return {
    kind: "child",
    name: "aggregate",
    label: `Merge review findings for issue ${state.n}`,
    agent: "issue-pipeline-reader",
    model: ctx.models.aggregator,
    schema: AGG_SCHEMA,
    minutes: AGGREGATE_MINUTES,
    task: aggregateTask(ctx, state, raw),
  };
}

// Posts each reviewer's comment. A clean review moves to sync; blocking
// findings go to the aggregator, carrying the raw findings for its fallback.
function reviewed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const { comments, raw, failed } = readReviews(
    state,
    sessionsOf(LENS_NAMES, results),
  );
  if (failed !== null) {
    return stopStep(state, "a reviewer failed", failed, comments);
  }
  const st = { ...state.st, reviewedSha: state.st.headSha ?? null };
  if (raw.length === 0) {
    st.stage = "sync";
    noteEvent(st, "review: no blocking findings", ctx.now());
    return saveStep({ ...state, st, phase: "saved" }, comments);
  }
  const charge = chargeSession(ctx.budgets, st, "aggregator", {
    at: ctx.now(),
  });
  if (!charge.charged) {
    return stopStep({ ...state, st }, charge.reason, charge.detail, comments);
  }
  const charged = { ...state, st, phase: "aggregated", carry: raw };
  return launchStep(charged, [aggregateLaunch(ctx, charged, raw)], comments);
}

function lensesOf(finding: MergedFinding): string[] {
  if (finding.lenses.length > 0) {
    return finding.lenses;
  }
  return ["correctness"];
}

// Numbers the merged findings, or the raw ones if the aggregator failed, and
// moves the issue to fix.
function aggregated(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  const raw = rawFindingsOf(state.carry);
  let merged: MergedFinding[] | null = null;
  if (result.ok) {
    merged = mergedFindingsOf(result.structuredOutput);
  }
  const st = copyState(state.st);
  const holder = { st };
  let added: Finding[] = [];
  let by = byStep("aggregator (fallback: raw findings)");
  if (merged === null) {
    added = raw.map((f) => addFinding(holder, f, [f.lens]));
  } else {
    added = merged.map((f) => addFinding(holder, f, lensesOf(f)));
    by = { ...result.by, role: "aggregator" };
  }
  st.stage = "fix";
  noteEvent(st, `review: ${added.length} blocking finding(s)`, ctx.now());
  return saveStep({ ...state, st, phase: "saved", carry: null }, [
    prComment(by, findingIdsComment(added)),
  ]);
}

// The saved review is done for this sweep.
function saved(state: StageState, results: readonly LaunchResult[]): Step {
  onlyReply(results);
  return doneStep(state);
}

// The review's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "prepared":
      return prepared(state, ctx, results);
    case "reviewed":
      return reviewed(state, ctx, results);
    case "aggregated":
      return aggregated(state, ctx, results);
    case "saved":
      return saved(state, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
