// Fix: one fix round per begin. The fixer resolves or disputes the open
// findings, the fix is pushed, and the re-reviewers judge it (rereview.ts).
// A round that leaves findings open ends with an again step, so the sweep
// holds the next round to the spawn cap; one past the last round stops. A
// disputed acceptance finding stops the round before the push, since only the
// operator can rule on what the issue asks. A fixer that runs out of room
// hands off to a continuation in the same round, up to config
// maxContinuations per issue (#269).

import { chargeSession } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import {
  acceptanceDisputeStop,
  findingsStopCode,
  findingsStopReason,
  findingsText,
  openFindings,
} from "../findings.ts";
import { FIX_SCHEMA } from "../review-schemas.ts";
import type { IssueState } from "../types.ts";
import {
  continuationsOf,
  continued,
  mayContinue,
  outOfRoomReason,
} from "./continuation.ts";
import { flowStep, prFlowed } from "./flow-step.ts";
import {
  launchRereviews,
  prepareRereview,
  roundOf,
  settleRereviews,
} from "./rereview.ts";
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
  phaseOf,
  prComment,
  pushFailedStep,
  replyError,
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

// Where the round is: about to launch the fixer, reading its reply, waiting
// for the push or its one retry, the re-review diff, the re-reviewers, or the
// save.
type FixPhase =
  | "begin"
  | "fixed"
  | "pushed"
  | "repushed"
  | "flowed"
  | "prepared"
  | "rereviewed"
  | "saved";

const PHASES: readonly FixPhase[] = [
  "begin",
  "fixed",
  "pushed",
  "repushed",
  "flowed",
  "prepared",
  "rereviewed",
  "saved",
];

const FIX_MINUTES = 60;
// The longest dispute evidence a finding keeps.
const DISPUTE_LIMIT = 600;

// The round's fixer, `fix-r<round>`, or `fix-r<round>-c<k>` for the issue's
// kth fixer continuation.
function fixerLaunch(
  ctx: StageContext,
  state: StageState,
  continuation = false,
): ChildLaunch {
  const round = roundOf(state);
  const open = openFindings(state);
  let name = `fix-r${round}`;
  if (continuation) {
    name += `-c${continuationsOf(state.st, "fix")}`;
  }
  return {
    kind: "child",
    name,
    label: `Fix review findings for issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: ctx.models.fixer,
    schema: FIX_SCHEMA,
    minutes: FIX_MINUTES,
    task: fixTask(ctx, state, { round, open, continuation }),
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

// A fixer that ran out of room: a continuation in the same round while the
// cap allows, else the issue stops as too large.
function handedOff(
  state: StageState,
  ctx: StageContext,
  reply: FixReply,
  comment: StageComment,
): Step {
  if (!mayContinue(state.st, ctx.cfg, "fix")) {
    return stopStep(
      state,
      outOfRoomReason("fixer", ctx.cfg.maxContinuations),
      `Latest handoff: ${state.paths.handoffFile}\n\n${reply.summary}`,
      [comment],
    );
  }
  const st = continued(copyState(state.st), "fix");
  const charge = chargeSession(ctx.budgets, st, "fixer", { at: ctx.now() });
  if (!charge.charged) {
    return stopStep({ ...state, st }, charge.reason, charge.detail, [comment]);
  }
  const continuing = { ...state, st, phase: "fixed" };
  return launchStep(
    continuing,
    [fixerLaunch(ctx, continuing, true)],
    [comment],
  );
}

// Records the fixer's disputes and posts its comment, then pushes the fix,
// stops if it disputed the acceptance finding, or continues from its handoff.
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
  const comment = prComment(by, fixComment(reply));
  const disputed = acceptanceDisputeStop({ st });
  if (disputed !== null) {
    return codedStopStep({ ...state, st }, disputed, [comment]);
  }
  const { status } = reply;
  switch (status) {
    case "handoff":
      return handedOff({ ...state, st }, ctx, reply, comment);
    case "done":
      return launchStep(
        { ...state, st, phase: "pushed" },
        [
          {
            kind: "op",
            name: "push",
            op: "push",
            payload: { number: state.n },
          },
        ],
        [comment],
      );
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

// Records the pushed head and acts on the flows (flow-step.ts), then prepares
// the diff since the last review. A failed push is retried once unless git's
// push was rejected.
function pushed(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const reply = onlyReply(results);
  const { ok, error, headSha } = reply;
  if (ok !== true || typeof headSha !== "string") {
    return pushFailedStep(state, "could not push the fix", replyError(error));
  }
  const st = { ...state.st, headSha };
  return flowStep({ ...state, st }, ctx, reply, {
    phase: "flowed",
    goOn: prepareRereview,
  });
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
  const phase = phaseOf("fix", PHASES, state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "fixed":
      return fixed(state, ctx, results);
    case "pushed":
    case "repushed":
      return pushed(state, ctx, results);
    case "flowed":
      return prFlowed(state, ctx, results, prepareRereview);
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
