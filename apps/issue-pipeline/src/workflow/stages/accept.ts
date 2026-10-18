// Acceptance: a reader checks that the change, as a whole, does what the issue
// (and its spec) asks. A pass moves the issue to the security review; a fail
// becomes a blocking finding in the acceptance lens and sends the issue to fix.
// A head whose changes have the patch id the last pass judged keeps that
// verdict with no session (review-keeps-on-clean-rebase).

import { sessionBudget } from "../budget.ts";
import { noteEvent } from "../event-log.ts";
import { addFinding } from "../findings.ts";
import { preamble, specText } from "../prompts.ts";
import { ACCEPT_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import { byStep } from "../signing.ts";
import type { IssueState, RepoConfig, ReportedFinding } from "../types.ts";
import { finalDiffLaunch, finalDiffOf } from "./final-diff.ts";
import { sessionFailedStep } from "./rate-limit.ts";
import type { AcceptReply } from "./replies.ts";
import { acceptReplyOf } from "./replies.ts";
import { patchIdIn } from "./reply-guards.ts";
import { doneStep, launchStep, onlyChild, onlyReply } from "./step.ts";
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
// The role the verifier signs its comments as.
const ACCEPT_ROLE = "acceptance verifier";
const SHORT_SHA = 12;

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

// What the verifier's task reads of the issue: its number, paths, spec and
// the checks' summary. A stage gives its own state; the reviewer role gives
// just these (#423).
interface AcceptTaskItem {
  n: number;
  paths: StageState["paths"];
  st: Pick<IssueState, "spec" | "specFile" | "verifySummary">;
}

// The acceptance verifier's task over the final diff at `diffPath`.
function acceptTask(
  cfg: RepoConfig,
  item: AcceptTaskItem,
  diffPath: string,
): string {
  const spec = specText(item.st);
  const lines = [
    `Decide whether the change, as a whole, does what the issue asks. Tests, lint, and CI already pass (${item.st.verifySummary ?? ""}); do not re-run them.`,
    specLine(spec),
    `Full diff against ${cfg.baseBranch}: ${diffPath}.`,
    `Return \`pass\` only if every requirement in the issue${specRequirements(spec)} is met and nothing in the diff works against the issue. Otherwise \`fail\` with the unmet requirement. Do not edit files.`,
  ];
  return preamble(cfg, item, ACCEPT_ROLE).concat(lines).join("\n");
}

function acceptLaunch(
  state: StageState,
  ctx: StageContext,
  diffPath: string,
): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const budget = sessionBudget(budgets, "verifier");
  return {
    kind: "child",
    name: "accept",
    label: `Check issue ${state.n} is resolved`,
    agent: "issue-pipeline-reader",
    model: models.verifier,
    schema: ACCEPT_SCHEMA,
    minutes: ACCEPT_MINUTES,
    budgetRole: "verifier",
    tokenBudget: budget,
    task: acceptTask(cfg, state, diffPath),
  };
}

// Prepares the final diff.
function begin(state: StageState): Step {
  return launchStep({ ...state, phase: "review" }, [
    finalDiffLaunch(state, "final"),
  ]);
}

// What a kept verdict logs and comments: the head the last pass judged.
function keptText(acceptedSha: string | null | undefined): string {
  const since = (acceptedSha ?? "").slice(0, SHORT_SHA);
  return `acceptance kept: changes unchanged since ${since}`;
}

// Moves to security with no session, saving first: the changes are those
// the last pass judged.
function kept(state: StageState, ctx: StageContext): Step {
  const st = { ...state.st, stage: "security" };
  const text = keptText(st.acceptedSha);
  noteEvent(st, text, ctx.now());
  const payload = { number: state.n, state: st };
  const by = byStep(ACCEPT_ROLE);
  return launchStep(
    { ...state, st, phase: "saved" },
    [{ kind: "op", name: "save", op: "save-state", payload }],
    [{ by, body: `✅ ${text}.`, where: "pr" }],
  );
}

// Launches the verifier's session once the diff is ready, unless the
// changes have the patch id the last pass judged.
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
  const patchId = patchIdIn(onlyReply(results));
  if (patchId !== null && patchId === state.st.acceptedPatchId) {
    return kept(state, ctx);
  }
  return launchStep({ ...state, phase: "decide", carry: { patchId } }, [
    acceptLaunch(state, ctx, diff.path),
  ]);
}

// The verdict's comment text.
function verdictText(reply: AcceptReply): string {
  let opening = "❌ The change doesn't fully resolve the issue. ";
  if (reply.verdict === "pass") {
    opening = "✅ The change does what the issue asks. ";
  }
  return `${opening}${reply.reason}`;
}

function verdictComment(reply: AcceptReply, by: Signature): StageComment {
  return {
    by: { ...by, role: ACCEPT_ROLE },
    body: verdictText(reply),
    where: "pr",
  };
}

// The open finding a fail stores in the acceptance lens: the unmet
// requirement, the verifier's `reason`, as its evidence.
function acceptanceFinding(reason: string): ReportedFinding {
  return {
    file: "",
    line: 0,
    title: "acceptance: issue not fully resolved",
    evidence: reason,
    suggestion:
      "Change the code, tests or docs so the issue and spec requirement named in the evidence is met.",
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
  addFinding({ st }, acceptanceFinding(reply.reason), ["acceptance"]);
  st.reviewedSha = st.verifiedSha ?? st.headSha ?? null;
  st.acceptedSha = null;
  st.acceptedPatchId = null;
  st.stage = "fix";
  const payload = { number: state.n, state: st };
  return launchStep(
    { ...state, st, phase: "saved" },
    [{ kind: "op", name: "save", op: "save-state", payload }],
    comments,
  );
}

// Logs and posts the verdict. The reason is kept in the state, since a merge
// queued behind an older PR runs in a later sweep, and a pass records the
// head and the patch id it judged.
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
    const reason = "the acceptance verifier failed";
    return sessionFailedStep(state, reason, result.error, ctx.now());
  }
  const st = { ...state.st };
  noteEvent(st, `acceptance: ${reply.verdict} - ${reply.reason}`, ctx.now());
  const comments = [verdictComment(reply, result.by)];
  if (reply.verdict !== "pass") {
    return failed({ ...state, st }, reply, comments);
  }
  st.acceptReason = reply.reason;
  st.acceptedSha = st.verifiedSha ?? null;
  st.acceptedPatchId = patchIdIn(state.carry);
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

export {
  ACCEPT_ROLE,
  acceptanceFinding,
  acceptTask,
  keptText,
  next,
  verdictText,
};
