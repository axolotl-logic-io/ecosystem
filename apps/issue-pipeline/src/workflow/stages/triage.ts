// Triage: decides whether the pipeline takes the issue on. A ready issue moves
// to spec and gets its draft PR; one that needs answers gets its questions; a
// large one moves to spec with its split suggested, for the spec writer to cut
// (#267); anything else is rejected with a stop.

import { startTriage } from "../../roles/triage/locate.ts";
import type { TriageDecision, TriageReply } from "../../roles/triage/reply.ts";
import {
  decisionOf,
  startedPrOf,
  triageReplyOf,
} from "../../roles/triage/reply.ts";
import {
  announcement,
  keptPlan,
  prEvent,
  REJECTED,
  TRIAGE_FAILED,
  triageEvent,
  triageSession,
} from "../../roles/triage/task.ts";
import { noteEvent } from "../event-log.ts";
import type { Signature } from "../signing.ts";
import type { IssueState } from "../types.ts";
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

// Where triage is: about to launch the session, reading its reply, waiting
// for the questions to be posted, or waiting for the draft PR.
type TriagePhase = "begin" | "decide" | "follow-up" | "start-pr";

const PHASES: readonly TriagePhase[] = [
  "begin",
  "decide",
  "follow-up",
  "start-pr",
];

const TRIAGE_MINUTES = 20;

function phaseOf(state: StageState): TriagePhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`triage: unknown phase ${state.phase}`);
  }
  return phase;
}

function triageLaunch(state: StageState, ctx: StageContext): ChildLaunch {
  const { st, n, paths } = state;
  const item = { n, paths, depth: st.depth, attempt: st.triages ?? 1 };
  const session = triageSession(item, ctx);
  return {
    ...session,
    kind: "child",
    label: `Triage issue ${n}`,
    minutes: TRIAGE_MINUTES,
  };
}

// Counts the run, then launches the session.
function begin(state: StageState, ctx: StageContext): Step {
  const { maxTriages } = ctx.cfg;
  const started = startTriage(state.st, maxTriages);
  const counted = { ...state, st: started.counted };
  const { stop } = started;
  if (stop !== null) {
    return stopStep(counted, stop.reason, stop.detail);
  }
  return launchStep({ ...counted, phase: "decide" }, [
    triageLaunch(counted, ctx),
  ]);
}

// The comment triage posts on the issue for `decision`, if any.
function announced(
  by: Signature,
  decision: TriageDecision,
  reason: string,
): StageComment[] {
  const body = announcement(decision, reason);
  if (body === null) {
    return [];
  }
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
    plan: keptPlan(plan),
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
  const comments = announced(by, "ready", reply.reason);
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
  return doneStep({ ...state, st }, announced(by, "split", reply.reason));
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
  const { reason } = reply;
  return stopStep(state, REJECTED, reason, announced(by, "reject", reason));
}

// Acts on the session's decision, as the role reads it (decisionOf).
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
    return stopStep(state, TRIAGE_FAILED, result.error);
  }
  const decision = decisionOf(reply, state.st.depth);
  const st = { ...state.st };
  noteEvent(st, triageEvent(reply, decision), ctx.now());
  const decided = { ...state, st };
  switch (decision) {
    case "ready":
      return ready(decided, reply, result.by);
    case "split":
      return suggestSplit(decided, reply, result.by);
    case "needs-info":
      return ask(decided, reply, result.by);
    case "reject":
      return reject(decided, reply, result.by);
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
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
  const reply = onlyReply(results);
  const started = startedPrOf(reply);
  const st = { ...state.st };
  if (started === null) {
    const { error } = reply;
    noteEvent(st, prEvent(null, error), ctx.now());
  } else {
    st.pr = started.pr;
    st.headSha = started.headSha;
    st.implemented = false;
    noteEvent(st, prEvent(started.pr, null), ctx.now());
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
