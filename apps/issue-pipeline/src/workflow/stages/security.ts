// The security review: the last review before merge, of the full diff at the
// verified head, for harm to the app's users and the operator. With no
// findings the issue moves to merge; findings go back through fresh fix rounds,
// until there have been more security rounds than fix rounds allow.

import { sessionBudget } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { addFinding, findingsStop } from "../findings.ts";
import { SECURITY_RULES } from "../lenses.ts";
import { preamble } from "../prompts.ts";
import { SECURITY_SCHEMA } from "../review-schemas.ts";
import type { Signature } from "../signing.ts";
import type { Finding, IssueState } from "../types.ts";
import { finalDiffLaunch, finalDiffOf } from "./final-diff.ts";
import { sessionFailedStep } from "./rate-limit.ts";
import type { SecurityReply } from "./replies.ts";
import { securityReplyOf } from "./replies.ts";
import { codedStopStep, doneStep, launchStep, onlyChild } from "./step.ts";
import type {
  ChildLaunch,
  LaunchResult,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where the review is: about to prepare the diff, launching the reviewer on
// it, reading the findings, or waiting for the state to save.
type SecurityPhase = "begin" | "review" | "decide" | "saved";

const PHASES: readonly SecurityPhase[] = ["begin", "review", "decide", "saved"];

const SECURITY_MINUTES = 25;
// How much of the head a comment names.
const SHA_LENGTH = 12;

function phaseOf(state: StageState): SecurityPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`security: unknown phase ${state.phase}`);
  }
  return phase;
}

function securityLaunch(
  state: StageState,
  ctx: StageContext,
  diff: { path: string; lines: string },
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const budget = sessionBudget(budgets, "reviewer");
  return {
    kind: "child",
    name: "security",
    label: `Security review of issue ${state.n}`,
    agent: "issue-pipeline-reader",
    model: models.security,
    schema: SECURITY_SCHEMA,
    minutes: SECURITY_MINUTES,
    budgetRole: "reviewer",
    tokenBudget: budget,
    task: preamble(cfg, state, "security reviewer")
      .concat([
        `You are the last review before this PR merges. Review the full diff against ${cfg.baseBranch} at ${diff.path} (${diff.lines} lines), reading surrounding code where needed, for harm to the app's users and the operator.`,
      ])
      .concat(SECURITY_RULES)
      .concat([
        "Cite file, line and concrete evidence for each finding. Return an empty list if you find nothing. Do not edit files.",
      ])
      .join("\n"),
  };
}

// The security rounds so far, counting this review.
function roundOf(st: IssueState): number {
  return (st.securityRounds ?? 0) + 1;
}

// Prepares the diff for this round.
function begin(state: StageState): Step {
  return launchStep({ ...state, phase: "review" }, [
    finalDiffLaunch(state, `security-${roundOf(state.st)}`),
  ]);
}

// Launches the reviewer's session once the diff is ready.
function review(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const failure = "could not prepare the security review diff";
  const diff = finalDiffOf(state, ctx, results, failure);
  if (!diff.ok) {
    return diff.step;
  }
  return launchStep({ ...state, phase: "decide" }, [
    securityLaunch(state, ctx, diff),
  ]);
}

function headOf(st: IssueState): string {
  const { verifiedSha } = st;
  if (typeof verifiedSha !== "string") {
    return "";
  }
  return verifiedSha.slice(0, SHA_LENGTH);
}

// Saves the state before the stage ends, so the save comes before any later
// stage's hold, stop or merge.
function saved(state: StageState, by: Signature, body: string): Step {
  const payload = { number: state.n, state: state.st };
  return launchStep(
    { ...state, phase: "saved" },
    [{ kind: "op", name: "save", op: "save-state", payload }],
    [{ by, body, where: "pr" }],
  );
}

function cleared(state: StageState, ctx: StageContext, by: Signature): Step {
  const st = { ...state.st, stage: "merge" };
  noteEvent(st, "security review: no findings", ctx.now());
  const body = `🛡️ Security review of ${headOf(st)}: no harm to users, their rights or money, and no new abuse risk.`;
  return saved({ ...state, st }, by, body);
}

function findingList(added: readonly Finding[]): string {
  return added
    .map(
      (f) =>
        `- **${f.id}** (${String(f.category)}) \`${f.file}:${f.line}\` ${f.title}\n  ${f.evidence}`,
    )
    .join("\n");
}

// Stores the findings, then stops past the fix rounds, or sends the verified
// head back through fresh fix rounds, then sync, checks, acceptance and this
// review.
function found(
  state: StageState,
  ctx: StageContext,
  by: Signature,
  reply: SecurityReply,
): Step {
  const securityRounds = roundOf(state.st);
  const st = { ...state.st, findings: [...state.st.findings], securityRounds };
  const item = { st };
  const added = reply.findings.map((f) => addFinding(item, f, ["security"]));
  const body = `🛡️ Security review of ${headOf(st)} found ${added.length} blocking finding(s). Later comments refer to these ids.\n\n${findingList(added)}`;
  const line = `security review ${securityRounds}: ${added.length} finding(s)`;
  noteEvent(st, line, ctx.now());
  if (securityRounds > ctx.cfg.maxFixRounds) {
    return codedStopStep(
      { ...state, st },
      findingsStop(ctx.cfg, item, "security findings remain"),
      [{ by, body, where: "pr" }],
    );
  }
  st.reviewedSha = st.verifiedSha ?? null;
  st.round = 0;
  st.stage = "fix";
  return saved({ ...state, st }, by, body);
}

function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  let reply: SecurityReply | null = null;
  if (result.ok) {
    reply = securityReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    const reason = "the security reviewer failed";
    return sessionFailedStep(state, reason, result.error, ctx.now());
  }
  const by = { ...result.by, role: "security reviewer" };
  if (reply.findings.length === 0) {
    return cleared(state, ctx, by);
  }
  return found(state, ctx, by, reply);
}

// The security review's next step, from its state and the results of its
// last launches.
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
      return doneStep(state);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
