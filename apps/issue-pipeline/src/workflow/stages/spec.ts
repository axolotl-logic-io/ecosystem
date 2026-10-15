// Spec: what exactly to build, from the issue, the wiki, the code and the web.
// Autumn (2026-10-13): every issue gets a spec before implementation. It is
// posted on the issue, and the implementer and the acceptance check work from
// it. A spec that needs a maintainer's answer goes back to triage with its
// questions.

import { chargeSession } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import { practicesNote, preamble } from "../prompts.ts";
import { SPEC_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type { SpecReply } from "./build-replies.ts";
import { specReplyOf } from "./build-replies.ts";
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
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where spec is: about to launch the session, reading its reply, or waiting
// for its questions to be posted.
type SpecPhase = "begin" | "decide" | "follow-up";

const PHASES: readonly SpecPhase[] = ["begin", "decide", "follow-up"];

// The longest spec the state keeps.
const SPEC_LIMIT = 12_000;
const SPEC_MINUTES = 30;
const ROLE = "spec writer";

function phaseOf(state: StageState): SpecPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`spec: unknown phase ${state.phase}`);
  }
  return phase;
}

function planText(plan: string | null | undefined): string {
  if (typeof plan !== "string" || plan === "") {
    return "(none)";
  }
  return plan;
}

// Where the spec writer starts reading the wiki, or "" when there is none.
function wikiStart(state: StageState): string {
  const { wiki } = state.paths;
  if (wiki === null || wiki === "") {
    return "";
  }
  return ` (start from ${wiki}/Home.md)`;
}

function specTask(state: StageState, ctx: StageContext): string {
  const { cfg, budgets } = ctx;
  const lines = [
    `Triage found this issue ready. Its notes:\n${planText(state.st.plan)}`,
    "",
    `Write the spec the implementer will build to and the acceptance check will judge against. Read, in this order: the issue; the project's coding practices (below); the wiki pages that bear on it${wikiStart(state)}; the code it touches; and, only for what the repo can't answer, the web (library APIs, standards, platform limits). Cite each source.`,
    practicesNote(cfg, state, "spec"),
    "`spec` is GitHub markdown with these sections:",
    "- **Behaviour**: what is true when the issue is done, as checkable statements.",
    "- **Out of scope**: what this issue does not change.",
    "- **Design**: the approach, the files to change with `file:line` anchors, and the coding practices and wiki decisions it follows. If it departs from a wiki decision, say which and why, and say the implementer must update that wiki page.",
    "- **Tests**: the tests to add or change, each naming the behaviour it pins down and why it fails today.",
    '- **Wiki updates**: wiki pages to add or change, or "None".',
    "- **Assumptions and risks**, then **Sources** (files, wiki pages, URLs).",
    "Keep it under about 150 lines. Set `decision` to ready, with `questions` empty.",
    "Only if the work can't be specified without a maintainer's answer, set `decision` to needs-info, ask at most 5 specific questions, and put what you found so far in `spec`.",
  ];
  return preamble(cfg, state, ROLE, budgets.roles.spec)
    .concat(lines)
    .join("\n");
}

function specLaunch(state: StageState, ctx: StageContext): ChildLaunch {
  return {
    kind: "child",
    name: "spec",
    role: ROLE,
    label: `Write the spec for issue ${state.n}`,
    agent: "issue-pipeline-specifier",
    model: ctx.models.spec,
    schema: SPEC_SCHEMA,
    minutes: SPEC_MINUTES,
    task: specTask(state, ctx),
  };
}

// Charges the session, then launches it.
function begin(state: StageState, ctx: StageContext): Step {
  const st = { ...state.st };
  const charge = chargeSession(ctx.budgets, st, "spec", {
    at: ctx.now(),
  });
  if (!charge.charged) {
    return stopStep(state, charge.reason, charge.detail);
  }
  const charged = { ...state, st };
  return launchStep({ ...charged, phase: "decide" }, [
    specLaunch(charged, ctx),
  ]);
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

// Keeps the spec, moves the issue to implement and posts the spec.
function ready(state: StageState, reply: SpecReply, by: Signature): Step {
  const st = {
    ...state.st,
    spec: clip(reply.spec, SPEC_LIMIT),
    stage: "implement",
  };
  const body = `## Spec\n\nThe implementer builds to this spec, and the acceptance check judges the result against it.\n\n${reply.spec}`;
  return doneStep({ ...state, st }, [{ by, body, where: "issue" }]);
}

// Acts on the spec writer's decision. Questions it didn't ask read as ready.
function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  let reply: SpecReply | null = null;
  if (result.ok) {
    reply = specReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    return stopStep(state, "the spec writer failed", result.error);
  }
  const st = { ...state.st };
  noteEvent(st, `spec: ${reply.decision}`, ctx.now());
  const decided = { ...state, st };
  if (reply.decision === "needs-info" && reply.questions.length > 0) {
    return ask(decided, reply, result.by);
  }
  return ready(decided, reply, result.by);
}

// The questions were posted; a failure aborts the sweep.
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
  const phase = phaseOf(state);
  switch (phase) {
    case "begin":
      return begin(state, ctx);
    case "decide":
      return decide(state, ctx, results);
    case "follow-up":
      return followedUp(state, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
