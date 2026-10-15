// Fix: one fix round per begin. The fixer resolves or disputes the open
// findings, the fix is pushed, and the re-reviewers judge it (rereview.ts).
// A round that leaves findings open ends with an again step, so the sweep
// holds the next round to the spawn cap; one past the last round stops.

import { chargeSession } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import {
  findingsStopCode,
  findingsStopReason,
  findingsText,
  openFindings,
} from "../findings.ts";
import { FIX_SCHEMA } from "../review-schemas.ts";
import type { IssueState } from "../types.ts";
import { launchRereviews, roundOf, settleRereviews } from "./rereview.ts";
import type { Dispute, FixReply } from "./review-replies.ts";
import { fixReplyOf } from "./review-replies.ts";
import { fixComment, fixTask } from "./review-text.ts";
import {
  againStep,
  codedStopStep,
  copyState,
  doneStep,
  launchStep,
  onlyChild,
  onlyReply,
  prComment,
  replyError,
  stopStep,
} from "./step.ts";
import type {
  ChildLaunch,
  LaunchResult,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where the round is: about to launch the fixer, reading its reply, waiting
// for the push, the re-review diff, the re-reviewers, or the save.
type FixPhase =
  | "begin"
  | "fixed"
  | "pushed"
  | "prepared"
  | "rereviewed"
  | "saved";

const PHASES: readonly FixPhase[] = [
  "begin",
  "fixed",
  "pushed",
  "prepared",
  "rereviewed",
  "saved",
];

const FIX_MINUTES = 60;
// The longest dispute evidence a finding keeps.
const DISPUTE_LIMIT = 600;

function phaseOf(state: StageState): FixPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`fix: unknown phase ${state.phase}`);
  }
  return phase;
}

function fixerLaunch(ctx: StageContext, state: StageState): ChildLaunch {
  const round = roundOf(state);
  return {
    kind: "child",
    name: `fix-r${round}`,
    label: `Fix review findings for issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: ctx.models.fixer,
    schema: FIX_SCHEMA,
    minutes: FIX_MINUTES,
    task: fixTask(ctx, state, round, openFindings(state)),
    writer: true,
  };
}

// Stops once the fix rounds are used up; otherwise charges the fixer, counts
// the round and launches it.
function begin(state: StageState, ctx: StageContext): Step {
  const { maxFixRounds } = ctx.cfg;
  const round = roundOf(state);
  if (round >= maxFixRounds) {
    const base = `blocking findings remain after ${maxFixRounds} fix rounds`;
    return codedStopStep(state, {
      reason: findingsStopReason(ctx.cfg, state, base),
      detail: findingsText(openFindings(state)),
      code: findingsStopCode(state),
    });
  }
  const st = copyState(state.st);
  const charge = chargeSession(ctx.budgets, st, "fixer", {
    at: ctx.now(),
  });
  if (!charge.charged) {
    return stopStep({ ...state, st }, charge.reason, charge.detail);
  }
  st.round = round + 1;
  const begun = { ...state, st, phase: "fixed" };
  return launchStep(begun, [fixerLaunch(ctx, begun)]);
}

// Records each dispute on its open finding, once.
function recordDisputes(st: IssueState, disputes: readonly Dispute[]): void {
  for (const dispute of disputes) {
    const finding = st.findings.find(
      (f) => f.id === dispute.id && f.status === "open",
    );
    if (finding !== undefined && !finding.disputed) {
      finding.disputed = true;
      finding.dispute = clip(dispute.evidence, DISPUTE_LIMIT);
    }
  }
}

// Records the fixer's disputes and posts its comment, then pushes the fix.
function fixed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  let reply: FixReply | null = null;
  if (result.ok) {
    reply = fixReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    return stopStep(state, "the fixer session failed", result.error);
  }
  const round = roundOf(state);
  const st = copyState(state.st);
  recordDisputes(st, reply.disputed);
  noteEvent(st, `fix round ${round}: ${reply.summary}`, ctx.now());
  const by = { ...result.by, role: `fixer (round ${round})` };
  return launchStep(
    { ...state, st, phase: "pushed" },
    [{ kind: "op", name: "push", op: "push", payload: { number: state.n } }],
    [prComment(by, fixComment(reply))],
  );
}

// The re-review diff's tag: the round, after the security round if any.
function prepTag(st: IssueState, round: number): string {
  const { securityRounds = 0 } = st;
  if (securityRounds === 0) {
    return `r${round}`;
  }
  return `s${securityRounds}-r${round}`;
}

// Records the pushed head, then prepares the diff since the last review.
function pushed(state: StageState, results: readonly LaunchResult[]): Step {
  const { ok, error, headSha } = onlyReply(results);
  if (ok !== true || typeof headSha !== "string") {
    return stopStep(state, "could not push the fix", replyError(error));
  }
  const st = { ...state.st, headSha };
  const payload = {
    number: state.n,
    sinceSha: st.reviewedSha,
    tag: prepTag(st, roundOf(state)),
  };
  return launchStep({ ...state, st, phase: "prepared" }, [
    { kind: "op", name: "prep", op: "prepare-review", payload },
  ]);
}

// The saved round is finished; one that left findings open goes again.
function saved(state: StageState, results: readonly LaunchResult[]): Step {
  onlyReply(results);
  if (state.st.stage === "fix") {
    return againStep(state);
  }
  return doneStep(state);
}

// The fix round's next step, from its state and the results of its last
// launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "fixed":
      return fixed(state, ctx, results);
    case "pushed":
      return pushed(state, results);
    case "prepared":
      return launchRereviews(state, ctx, results);
    case "rereviewed":
      return settleRereviews(state, ctx, results);
    case "saved":
      return saved(state, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
