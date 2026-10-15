// Triage: decides whether the pipeline takes the issue on. A ready issue moves
// to spec and gets its draft PR; one that needs answers gets its questions; a
// large one is split into sub-issues; anything else is rejected with a stop.

import { chargeSession } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import { preamble } from "../prompts.ts";
import { TRIAGE_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
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
// for the questions or the split, or waiting for the draft PR.
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
const MIN_SUB_ISSUES = 2;

function phaseOf(state: StageState): TriagePhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`triage: unknown phase ${state.phase}`);
  }
  return phase;
}

// The line on splitting: a sub-issue may not split again.
const SPLIT_ALLOWED: string =
  "- split: too big for one session. Give 2 to 5 sub-issues, each a complete, independently testable change with its own acceptance criteria. Use `after` to list the 0-based indexes of earlier sub-issues that must merge first. Sub-issues without `after` run in parallel, and each merge makes the others rebase onto it, so two that edit the same file conflict and redo their checks. Cut along file boundaries: give each file to one sub-issue where you can, and name each one's files in its body. Where two must edit the same file, such as a shared index, registry or wiki page, put one `after` the other so they run in turn. Prefer fewer sub-issues to many that share files.";
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
  const lines = [
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
    task: preamble(cfg, state, "triage", budgets.roles.triage)
      .concat(lines)
      .join("\n"),
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

// Moves the issue to spec, and opens its draft PR if it has none, so the issue
// links to its branch and PR while work is under way.
function ready(state: StageState, reply: TriageReply, by: Signature): Step {
  const st = {
    ...state.st,
    plan: clip(reply.plan, PLAN_LIMIT),
    stage: "spec",
  };
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

function ask(state: StageState, reply: TriageReply, by: Signature): Step {
  const { questions } = reply;
  const payload = { number: state.n, state: state.st, questions, by };
  return launchStep(
    { ...state, closed: true, outcome: "needs-info", phase: "follow-up" },
    [{ kind: "op", name: "ask", op: "ask", payload }],
  );
}

function split(state: StageState, reply: TriageReply, by: Signature): Step {
  const { subIssues } = reply;
  const payload = { number: state.n, state: state.st, subIssues, by };
  return launchStep(
    { ...state, closed: true, outcome: "split", phase: "follow-up" },
    [{ kind: "op", name: "split", op: "split", payload }],
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

// Acts on the session's decision. A split or questions the pipeline can't act
// on reads as a reject.
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
  const st = { ...state.st };
  noteEvent(st, `triage: ${reply.decision} - ${reply.reason}`, ctx.now());
  const decided = { ...state, st };
  const { decision, questions, subIssues } = reply;
  if (decision === "ready") {
    return ready(decided, reply, result.by);
  }
  if (decision === "needs-info" && questions.length > 0) {
    return ask(decided, reply, result.by);
  }
  if (
    decision === "split" &&
    st.depth < 1 &&
    subIssues.length >= MIN_SUB_ISSUES
  ) {
    return split(decided, reply, result.by);
  }
  return reject(decided, reply, result.by);
}

// The questions or the split were posted; a failure aborts the sweep.
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
