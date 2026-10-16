// Triage: decides whether the pipeline takes the issue on. A ready issue moves
// to spec and gets its draft PR; one that needs answers gets its questions; a
// large one moves to spec with its split suggested, for the spec writer to cut
// (#267); anything else is rejected with a stop.

import { chargeSession, sessionBudget } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import { preamble } from "../prompts.ts";
import { TRIAGE_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type { IssueState } from "../types.ts";
import {
  doneStep,
  launchStep,
  onlyChild,
  onlyReply,
  stopStep,
} from "./step.ts";
import type { TriageReply } from "./triage-reply.ts";
import { triageReplyOf } from "./triage-reply.ts";
import type {
  ChildLaunch,
  LaunchResult,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where triage is: about to launch the session, reading its reply, waiting
// for the questions to be posted, or waiting for the draft PR.
type TriagePhase = "begin" | "decide" | "follow-up" | "start-pr";

const PHASES: readonly TriagePhase[] = [
  "begin",
  "decide",
  "follow-up",
  "start-pr",
];

// The longest plan the state keeps.
const PLAN_LIMIT = 4000;
// The longest error a failed draft PR logs.
const PR_ERROR_LIMIT = 300;
const TRIAGE_MINUTES = 20;

function phaseOf(state: StageState): TriagePhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`triage: unknown phase ${state.phase}`);
  }
  return phase;
}

// The line on splitting: a sub-issue may not split again.
const SPLIT_ALLOWED: string =
  "- split: too big for one session. Say why in `reason` and write `plan` as for ready; the spec writer decides how to cut it.";
const SPLIT_FORBIDDEN: string =
  "- split: NOT allowed; this issue is already a sub-issue. If it is still too big, choose reject and say so.";

function splitLine(depth: number): string {
  if (depth >= 1) {
    return SPLIT_FORBIDDEN;
  }
  return SPLIT_ALLOWED;
}

function triageLaunch(state: StageState, ctx: StageContext): ChildLaunch {
  const { cfg, budgets, models } = ctx;
  const budget = sessionBudget(budgets, "triage");
  const lines = [
    `If ${state.paths.handoffFile} exists, an earlier implementer session wrote it when it ran out of room: read it and the commits on \`agent/issue-${state.n}\` before you decide.`,
    "Read the issue and as much of the code as you need to decide one of:",
    `- ready: one implementer session (at most ${budgets.sessionCap} tokens of context) can implement and test it. Write \`plan\`: at most 15 lines naming the files and approach you found. A spec writer turns it into the full spec next.`,
    "- needs-info: a competent engineer could not start without answers. Ask at most 5 specific questions. If earlier questions were answered in the comments, use the answers.",
    splitLine(state.st.depth),
    "- reject: not suitable for an agent (design debate, production incident, needs production access, not a code change). Explain in `reason`. Issues that change CI workflows, auth, dependencies or migrations are suitable.",
    "Leave unused fields as empty strings or arrays.",
  ];
  return {
    kind: "child",
    name: "triage",
    label: `Triage issue ${state.n}`,
    agent: "issue-pipeline-reader",
    model: models.triage,
    schema: TRIAGE_SCHEMA,
    minutes: TRIAGE_MINUTES,
    tokenBudget: budget,
    task: preamble(cfg, state, "triage", budget).concat(lines).join("\n"),
  };
}

// Counts the run and charges the session, then launches it.
function begin(state: StageState, ctx: StageContext): Step {
  const { maxTriages } = ctx.cfg;
  const triages = (state.st.triages ?? 0) + 1;
  const counted = { ...state, st: { ...state.st, triages } };
  if (triages > maxTriages) {
    return stopStep(
      counted,
      `triage ran ${maxTriages} times without reaching a decision the pipeline can act on`,
      null,
    );
  }
  const charge = chargeSession(ctx.budgets, counted.st, "triage", {
    at: ctx.now(),
  });
  if (!charge.charged) {
    return stopStep(counted, charge.reason, charge.detail);
  }
  return launchStep({ ...counted, phase: "decide" }, [
    triageLaunch(counted, ctx),
  ]);
}

function issueComment(by: Signature, body: string): StageComment[] {
  return [{ by, body, where: "issue" }];
}

// The issue's state once triage takes it on: at spec with its plan, and with
// triage's too-big reason when it suggested a split. A ready triage clears an
// earlier suggestion.
function takenState(
  state: StageState,
  plan: string,
  splitSuggested: string | null,
): IssueState {
  const st: IssueState = {
    ...state.st,
    plan: clip(plan, PLAN_LIMIT),
    stage: "spec",
  };
  if (splitSuggested !== null || typeof st.splitSuggested === "string") {
    st.splitSuggested = splitSuggested;
  }
  return st;
}

// Moves the issue to spec, and opens its draft PR if it has none, so the issue
// links to its branch and PR while work is under way.
function ready(state: StageState, reply: TriageReply, by: Signature): Step {
  const st = takenState(state, reply.plan, null);
  const comments = issueComment(
    by,
    `Taking this issue. ${reply.reason} A spec follows.`,
  );
  const { pr } = st;
  if (typeof pr === "number" && pr > 0) {
    return doneStep({ ...state, st }, comments);
  }
  const payload = { number: state.n, plan: st.plan };
  return launchStep(
    { ...state, st, phase: "start-pr" },
    [{ kind: "op", name: "startpr", op: "start-pr", payload }],
    comments,
  );
}

// Moves a large issue to spec with its split suggested. It opens no draft PR:
// the split op, which the spec writer's split goes through, wouldn't close it.
function suggestSplit(
  state: StageState,
  reply: TriageReply,
  by: Signature,
): Step {
  const st = takenState(state, reply.plan, reply.reason);
  return doneStep(
    { ...state, st },
    issueComment(
      by,
      `Taking this issue. ${reply.reason} A spec follows, which may split it.`,
    ),
  );
}

function ask(state: StageState, reply: TriageReply, by: Signature): Step {
  const { questions } = reply;
  const payload = { number: state.n, state: state.st, questions, by };
  return launchStep(
    { ...state, closed: true, outcome: "needs-info", phase: "follow-up" },
    [{ kind: "op", name: "ask", op: "ask", payload }],
  );
}

function reject(state: StageState, reply: TriageReply, by: Signature): Step {
  return stopStep(
    state,
    "triage rejected the issue for the agent pipeline",
    reply.reason,
    issueComment(
      by,
      `This issue isn't one the pipeline should take on: ${reply.reason}`,
    ),
  );
}

// Acts on the session's decision. A sub-issue's split, or questions the
// pipeline can't act on, reads as a reject.
function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  let reply: TriageReply | null = null;
  if (result.ok) {
    reply = triageReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    return stopStep(state, "triage failed", result.error);
  }
  const { decision, questions } = reply;
  const suggestsSplit = decision === "split" && state.st.depth < 1;
  let event: string = decision;
  if (suggestsSplit) {
    event = "split-suggested";
  }
  const st = { ...state.st };
  noteEvent(st, `triage: ${event} - ${reply.reason}`, ctx.now());
  const decided = { ...state, st };
  if (decision === "ready") {
    return ready(decided, reply, result.by);
  }
  if (suggestsSplit) {
    return suggestSplit(decided, reply, result.by);
  }
  if (decision === "needs-info" && questions.length > 0) {
    return ask(decided, reply, result.by);
  }
  return reject(decided, reply, result.by);
}

// The questions were posted; a failure aborts the sweep.
function followedUp(state: StageState, results: readonly LaunchResult[]): Step {
  const { ok, error } = onlyReply(results);
  if (ok !== true) {
    throw new Error(`triage follow-up failed: ${String(error)}`);
  }
  return doneStep(state);
}

// Records the draft PR. A failure is only logged: open-pr creates the PR
// after implementation.
function prStarted(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const { ok, error, pr, headSha } = onlyReply(results);
  const st = { ...state.st };
  if (ok === true && typeof pr === "number" && typeof headSha === "string") {
    st.pr = pr;
    st.headSha = headSha;
    st.implemented = false;
    noteEvent(st, `opened draft PR #${pr}`, ctx.now());
  } else {
    const failure = clip(String(error), PR_ERROR_LIMIT);
    noteEvent(st, `could not open the draft PR yet: ${failure}`, ctx.now());
  }
  return doneStep({ ...state, st });
}

// Triage's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "decide":
      return decide(state, ctx, results);
    case "follow-up":
      return followedUp(state, results);
    case "start-pr":
      return prStarted(state, ctx, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
