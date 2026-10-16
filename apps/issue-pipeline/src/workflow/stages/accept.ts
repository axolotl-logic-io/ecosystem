// Acceptance: a reader checks that the change, as a whole, does what the issue
// (and its spec) asks. A pass moves the issue to the security review; a fail
// becomes a blocking finding in the acceptance lens and sends the issue to fix.

import { chargeSession } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { addFinding } from "../findings.ts";
import { preamble } from "../prompts.ts";
import { ACCEPT_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import { finalDiffLaunch, finalDiffOf } from "./final-diff.ts";
import type { AcceptReply } from "./replies.ts";
import { acceptReplyOf } from "./replies.ts";
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

// Where acceptance is: about to prepare the diff, launching the verifier on
// it, reading the verdict, or waiting for a failed check's save.
type AcceptPhase = "begin" | "review" | "decide" | "saved";

const PHASES: readonly AcceptPhase[] = ["begin", "review", "decide", "saved"];

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

// Prepares the final diff.
function begin(state: StageState): Step {
  return launchStep({ ...state, phase: "review" }, [
    finalDiffLaunch(state, "final"),
  ]);
}

// Charges the verifier's session once the diff is ready, then launches it.
function review(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const failure = "could not prepare the final diff";
  const diff = finalDiffOf(state, ctx, results, failure);
  if (!diff.ok) {
    return diff.step;
  }
  const st = { ...state.st };
  const charged = { ...state, st };
  const charge = chargeSession(ctx.budgets, st, "verifier", {
    at: ctx.now(),
  });
  if (!charge.charged) {
    return stopStep(charged, charge.reason, charge.detail);
  }
  return launchStep({ ...charged, phase: "decide" }, [
    acceptLaunch(charged, ctx, diff.path),
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

// Stores the unmet requirement as an open acceptance finding and sends the
// issue to fix, saving the state before the stage ends. The fix round counts
// toward the fix rounds.
function failed(
  state: StageState,
  reply: AcceptReply,
  comments: readonly StageComment[],
): Step {
  const st = { ...state.st, findings: [...state.st.findings] };
  addFinding(
    { st },
    {
      file: "",
      line: 0,
      title: "acceptance: issue not fully resolved",
      evidence: reply.reason,
      suggestion:
        "Change the code, tests or docs so the issue and spec requirement named in the evidence is met.",
    },
    ["acceptance"],
  );
  st.reviewedSha = st.verifiedSha ?? st.headSha ?? null;
  // The fix brings new code, which is not a re-check after a rebase.
  st.rechecking = false;
  st.stage = "fix";
  const payload = { number: state.n, state: st };
  return launchStep(
    { ...state, st, phase: "saved" },
    [{ kind: "op", name: "save", op: "save-state", payload }],
    comments,
  );
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
    return failed({ ...state, st }, reply, comments);
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
      return begin(state);
    case "review":
      return review(state, ctx, results);
    case "decide":
      return decide(state, ctx, results);
    case "saved":
      onlyReply(results);
      return doneStep(state);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
