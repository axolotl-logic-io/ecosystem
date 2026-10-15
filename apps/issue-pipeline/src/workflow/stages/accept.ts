// Acceptance: a reader checks that the change, as a whole, does what the issue
// (and its spec) asks. A pass moves the issue to the security review; a fail
// stops it.

import { chargeSession } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { preamble } from "../prompts.ts";
import { ACCEPT_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import { finalDiffLaunch, finalDiffOf } from "./final-diff.ts";
import type { AcceptReply } from "./replies.ts";
import { acceptReplyOf } from "./replies.ts";
import {
  codedStopStep,
  doneStep,
  launchStep,
  onlyChild,
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

// Where acceptance is: about to prepare the diff, launching the verifier on
// it, or reading the verdict.
type AcceptPhase = "begin" | "review" | "decide";

const PHASES: readonly AcceptPhase[] = ["begin", "review", "decide"];

const ACCEPT_MINUTES = 25;

function phaseOf(state: StageState): AcceptPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`accept: unknown phase ${state.phase}`);
  }
  return phase;
}

// What the verifier also judges when the issue has a spec.
const SPEC_REQUIREMENTS: string =
  " and every Behaviour and Wiki update in the spec";
const NO_SPEC: string = "";

function specLine(spec: string): string {
  if (spec === "") {
    return NO_SPEC;
  }
  return `The spec it was built to (also on the issue):\n${spec}\n`;
}

function specRequirements(spec: string): string {
  if (spec === "") {
    return NO_SPEC;
  }
  return SPEC_REQUIREMENTS;
}

function acceptLaunch(
  state: StageState,
  ctx: StageContext,
  diffPath: string,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const spec = state.st.spec ?? "";
  const lines = [
    `Decide whether the change, as a whole, does what the issue asks. Tests, lint, and CI already pass (${state.st.verifySummary ?? ""}); do not re-run them.`,
    specLine(spec),
    `Full diff against ${cfg.baseBranch}: ${diffPath}.`,
    `Return \`pass\` only if every requirement in the issue${specRequirements(spec)} is met and nothing in the diff works against the issue. Otherwise \`fail\` with the unmet requirement. Do not edit files.`,
  ];
  return {
    kind: "child",
    name: "accept",
    label: `Check issue ${state.n} is resolved`,
    agent: "issue-pipeline-reader",
    model: models.verifier,
    schema: ACCEPT_SCHEMA,
    minutes: ACCEPT_MINUTES,
    task: preamble(cfg, state, "acceptance verifier", budgets.roles.verifier)
      .concat(lines)
      .join("\n"),
  };
}

// Charges the verifier's session, then prepares the final diff.
function begin(state: StageState, ctx: StageContext): Step {
  const st = { ...state.st };
  const charged = { ...state, st };
  const charge = chargeSession(ctx.budgets, st, "verifier");
  if (!charge.charged) {
    return stopStep(charged, "issue token budget exhausted", charge.detail);
  }
  return launchStep({ ...charged, phase: "review" }, [
    finalDiffLaunch(charged, "final"),
  ]);
}

function review(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const diff = finalDiffOf(state, results, "could not prepare the final diff");
  if (!diff.ok) {
    return codedStopStep(state, diff.stop);
  }
  return launchStep({ ...state, phase: "decide" }, [
    acceptLaunch(state, ctx, diff.path),
  ]);
}

function verdictComment(reply: AcceptReply, by: Signature): StageComment {
  let opening = "❌ The change doesn't fully resolve the issue. ";
  if (reply.verdict === "pass") {
    opening = "✅ The change does what the issue asks. ";
  }
  return {
    by: { ...by, role: "acceptance verifier" },
    body: `${opening}${reply.reason}`,
    where: "pr",
  };
}

// Logs and posts the verdict. The reason is kept in the state, since a merge
// queued behind an older PR runs in a later sweep.
function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  let reply: AcceptReply | null = null;
  if (result.ok) {
    reply = acceptReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    return stopStep(state, "the acceptance verifier failed", result.error);
  }
  const st = { ...state.st };
  noteEvent(st, `acceptance: ${reply.verdict} - ${reply.reason}`, ctx.now());
  const comments = [verdictComment(reply, result.by)];
  if (reply.verdict !== "pass") {
    return stopStep(
      { ...state, st },
      "the acceptance verifier found the issue is not fully resolved",
      reply.reason,
      comments,
    );
  }
  st.acceptReason = reply.reason;
  st.stage = "security";
  return doneStep({ ...state, st }, comments);
}

// Acceptance's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "review":
      return review(state, ctx, results);
    case "decide":
      return decide(state, ctx, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
