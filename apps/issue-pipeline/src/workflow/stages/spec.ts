// Spec: what exactly to build, from the issue, the wiki, the code and the web.
// Autumn (2026-10-13): every issue gets a spec before implementation. It is
// posted on the issue, and the implementer and the acceptance check work from
// it. A spec that needs a maintainer's answer goes back to triage with its
// questions, and an issue too big for two implementer sessions is split into
// sub-issues (spec-split.ts, #267). A failed spec session, including one whose
// spec stops partway, is tried once more (#280).

import { sessionBudget } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import { SPEC_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type { IssueState } from "../types.ts";
import type { SpecReply } from "./build-replies.ts";
import { SPEC_END, specReplyOf } from "./build-replies.ts";
import { isTransientSessionError, rateLimitStep } from "./rate-limit.ts";
import { isRecord, signatureOf } from "./reply-guards.ts";
import { splitStep } from "./spec-split.ts";
import { ROLE, specTask } from "./spec-task.ts";
import {
  doneStep,
  launchStep,
  onlyChild,
  onlyReply,
  phaseOf,
  replyError,
  stopStep,
} from "./step.ts";
import type {
  ChildLaunch,
  ChildResult,
  LaunchResult,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where spec is: about to launch the session, reading its reply, reading the
// reply of its one retry, waiting for the full spec to be saved, or waiting
// for its questions or its split to be posted.
type SpecPhase = "begin" | "decide" | "decide-again" | "saved" | "follow-up";

// The phases a spec session's reply is read in.
type DecidePhase = "decide" | "decide-again";

const PHASES: readonly SpecPhase[] = [
  "begin",
  "decide",
  "decide-again",
  "saved",
  "follow-up",
];

// The longest spec the state keeps; a longer one is saved whole to spec.md.
const SPEC_LIMIT = 12_000;
const SPEC_MINUTES = 30;

// A spec session's outcome: a whole reply, or why the session failed.
type SessionRead =
  | { ok: true; reply: SpecReply }
  | { ok: false; detail: string | null };

// A ready spec on its way to being kept, carried to "saved" while its full
// text is written to spec.md.
interface ReadySpec {
  spec: string;
  by: Signature;
}

function specLaunch(state: StageState, ctx: StageContext): ChildLaunch {
  const budget = sessionBudget(ctx.budgets, "spec");
  return {
    kind: "child",
    name: "spec",
    role: ROLE,
    label: `Write the spec for issue ${state.n}`,
    agent: "issue-pipeline-specifier",
    model: ctx.models.spec,
    schema: SPEC_SCHEMA,
    minutes: SPEC_MINUTES,
    budgetRole: "spec",
    tokenBudget: budget,
    task: specTask(state, ctx),
  };
}

// Launches a spec session, its reply read in `phase`.
function launchSession(
  state: StageState,
  ctx: StageContext,
  phase: DecidePhase,
): Step {
  return launchStep({ ...state, phase }, [specLaunch(state, ctx)]);
}

// Sends the questions back to triage, with what the spec writer found so far.
function ask(state: StageState, reply: SpecReply, by: Signature): Step {
  const { questions } = reply;
  const payload = {
    number: state.n,
    state: { ...state.st, stage: "triage" },
    questions,
    by,
  };
  return launchStep(
    { ...state, closed: true, outcome: "needs-info", phase: "follow-up" },
    [{ kind: "op", name: "ask", op: "ask", payload }],
    [{ by, body: `## Spec so far\n\n${reply.spec}`, where: "issue" }],
  );
}

// Keeps the spec, clipped, with the path of its full text when it was
// clipped, moves the issue to implement and posts the whole spec.
function kept(
  state: StageState,
  whole: ReadySpec,
  specFile: string | null,
): Step {
  const st: IssueState = {
    ...state.st,
    spec: clip(whole.spec, SPEC_LIMIT),
    // This spec writer leaves the spec's tests and stubs to the implementer;
    // #305's spec writer writes them and sets this true.
    specWritesTests: false,
    stage: "implement",
  };
  if (specFile !== null || typeof st.specFile === "string") {
    st.specFile = specFile;
  }
  const body = `## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.\n\n${whole.spec}`;
  return doneStep({ ...state, st, carry: null }, [
    { by: whole.by, body, where: "issue" },
  ]);
}

// Keeps a spec that fits SPEC_LIMIT at once; saves a longer one whole to
// spec.md first.
function ready(state: StageState, reply: SpecReply, by: Signature): Step {
  const spec: ReadySpec = { spec: reply.spec, by };
  if (reply.spec.length <= SPEC_LIMIT) {
    return kept(state, spec, null);
  }
  const payload = { number: state.n, spec: reply.spec };
  return launchStep({ ...state, phase: "saved", carry: spec }, [
    { kind: "op", name: "save-spec", op: "save-spec", payload },
  ]);
}

function readySpecOf(state: StageState): ReadySpec {
  const { carry } = state;
  if (isRecord(carry)) {
    const { spec, by } = carry;
    const signature = signatureOf(by);
    if (typeof spec === "string" && signature !== null) {
      return { spec, by: signature };
    }
  }
  throw new Error("spec: expected the spec to save");
}

// The full spec was saved, or the issue stops.
function saved(state: StageState, results: readonly LaunchResult[]): Step {
  const spec = readySpecOf(state);
  const { ok, error, specFile } = onlyReply(results);
  if (ok !== true || typeof specFile !== "string") {
    return stopStep(
      { ...state, carry: null },
      "could not save the full spec",
      replyError(error),
    );
  }
  return kept(state, spec, specFile);
}

// The session's whole reply, or why the session failed.
function sessionRead(result: ChildResult): SessionRead {
  if (!result.ok) {
    return { ok: false, detail: result.error };
  }
  const read = specReplyOf(result.structuredOutput);
  if (read === null) {
    return { ok: false, detail: "its reply did not fit the schema" };
  }
  if (!read.complete) {
    const detail = `its spec did not end with ${SPEC_END}, so it may stop partway`;
    return { ok: false, detail };
  }
  return { ok: true, reply: read.reply };
}

// Acts on the spec writer's decision. Questions it didn't ask read as ready.
// A failed session is tried once more; a second failure stops the issue. A
// session that hit a transient provider error defers it instead.
function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
  phase: DecidePhase,
): Step {
  const result = onlyChild(results);
  const read = sessionRead(result);
  if (!read.ok) {
    if (isTransientSessionError(result.error)) {
      return rateLimitStep(state, "the spec writer failed", ctx.now());
    }
    if (phase === "decide") {
      return launchSession(state, ctx, "decide-again");
    }
    return stopStep(state, "the spec writer failed twice", read.detail);
  }
  const { reply } = read;
  const st = { ...state.st };
  noteEvent(st, `spec: ${reply.decision}`, ctx.now());
  const decided = { ...state, st };
  if (reply.decision === "split") {
    return splitStep(decided, reply, result.by);
  }
  if (reply.decision === "needs-info" && reply.questions.length > 0) {
    return ask(decided, reply, result.by);
  }
  return ready(decided, reply, result.by);
}

// The questions or the split were posted; a failure aborts the sweep.
function followedUp(state: StageState, results: readonly LaunchResult[]): Step {
  const { ok, error } = onlyReply(results);
  if (ok !== true) {
    throw new Error(`spec follow-up failed: ${String(error)}`);
  }
  return doneStep(state);
}

// Spec's next step, from its state and the results of its last launches.
function next(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const phase = phaseOf("spec", PHASES, state);
  switch (phase) {
    case "begin":
      return launchSession(state, ctx, "decide");
    case "decide":
    case "decide-again":
      return decide(state, ctx, results, phase);
    case "saved":
      return saved(state, results);
    case "follow-up":
      return followedUp(state, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
