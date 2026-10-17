// Implement: one writer session builds the issue to its spec, tests and
// commits it. A session that runs out of room hands off to a continuation, up
// to config maxContinuations; the sweep begins the stage again for each. A
// done issue's commits are pushed, and the pushed head saved as its headSha,
// before it moves to open-pr: the stage job's checkout is removed when the job
// exits, and the next job's claim stops an issue whose branch moved past the
// saved head (#315).

import { sessionBudget } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import {
  commitRulesOf,
  handoffLead,
  handoffRule,
  practicesNote,
  preamble,
  specText,
} from "../prompts.ts";
import { IMPL_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type { ImplReply } from "./build-replies.ts";
import { implReplyOf } from "./build-replies.ts";
import {
  continuationsOf,
  continued,
  mayContinue,
  outOfRoomReason,
} from "./continuation.ts";
import { commandsClause, wikiStep } from "./implement-steps.ts";
import { sessionFailedStep } from "./rate-limit.ts";
import {
  doneStep,
  launchStep,
  onlyChild,
  onlyReply,
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

// Where implement is: about to launch the session, reading its reply, or
// reading the reply of the push of a done session's commits (or its retry).
type ImplementPhase = "begin" | "decide" | "pushed" | "repushed";

const PHASES: readonly ImplementPhase[] = [
  "begin",
  "decide",
  "pushed",
  "repushed",
];

const ROLE = "implementer";
const IMPLEMENT_MINUTES = 90;
const TITLE_LIMIT = 200;
const BODY_LIMIT = 6000;

function phaseOf(state: StageState): ImplementPhase {
  const phase = PHASES.find((entry) => entry === state.phase);
  if (phase === undefined) {
    throw new Error(`implement: unknown phase ${state.phase}`);
  }
  return phase;
}

// The spec's documented test and stub files the branch lacked at a restart,
// as a lead for the session; "" when there are none.
function unwrittenLead(st: StageState["st"]): string {
  const files = st.unwrittenFiles ?? [];
  if (files.length === 0) {
    return "";
  }
  const named = files.map((file) => `\`${file}\``).join(", ");
  return `The spec documents these test or stub files, which the branch lacks; write them as part of this work: ${named}.\n\n`;
}

// What the session works from: the handoff, the spec (with the handoff of a
// session before a restart, if any, `every-role-resumes`), or triage's plan,
// after any files the spec documents that the branch lacks.
function sourceLine(state: StageState): string {
  return `${unwrittenLead(state.st)}${workSource(state)}`;
}

function workSource(state: StageState): string {
  const { st, paths } = state;
  if (continuationsOf(st, "implement") > 0) {
    return handoffLead(paths.handoffFile);
  }
  const spec = specText(st);
  if (spec !== "") {
    return `If ${paths.handoffFile} exists, an earlier implementer session of this issue wrote it before the issue stopped: read it and the commits on the branch first, and build on them.\n\nSpec (also posted on the issue):\n${spec}`;
  }
  return `Triage plan:\n${String(st.plan)}`;
}

function implementTask(state: StageState, ctx: StageContext): string {
  const { cfg, budgets } = ctx;
  const lines = [
    practicesNote(cfg, state, "writer"),
    sourceLine(state),
    "",
    "Do this:",
    "1. Write or update tests that specify the fix. They must fail without your change.",
    "2. Implement the smallest change that resolves the issue. Do not refactor unrelated code.",
    `3. Run the tests${commandsClause(cfg.commands)} and fix failures.`,
    "4. Commit as you go (see below), and commit what is left at the end. Leave the worktree clean.",
    wikiStep(state.paths.wiki, ctx.committer),
    "Change lockfiles only through the package manager, never by hand.",
    "",
    ...commitRulesOf(ctx.committer, {
      unit: "step",
      when: "as soon as it builds and its tests pass",
      trailer: "Pipeline-Agent: implementer",
      clearMessage: true,
    }),
    handoffRule(
      budgets,
      state.paths.handoffFile,
      "make it build and commit it",
    ),
    "Return `blocked` only if the issue cannot be done as written; explain in `summary`.",
    "`prTitle` and `prBody` describe the change for reviewers (body: what changed and why, and how it is tested).",
  ];
  return preamble(cfg, state, ROLE).concat(lines).join("\n");
}

function implementLaunch(state: StageState, ctx: StageContext): ChildLaunch {
  const budget = sessionBudget(ctx.budgets, "implementer");
  return {
    kind: "child",
    name: "implement",
    role: ROLE,
    label: `Implement issue ${state.n}`,
    agent: "issue-pipeline-writer",
    model: ctx.models.implementer,
    schema: IMPL_SCHEMA,
    writer: true,
    minutes: IMPLEMENT_MINUTES,
    budgetRole: "implementer",
    tokenBudget: budget,
    task: implementTask(state, ctx),
  };
}

// Launches the session.
function begin(state: StageState, ctx: StageContext): Step {
  return launchStep({ ...state, phase: "decide" }, [
    implementLaunch(state, ctx),
  ]);
}

function issueComment(by: Signature, body: string): StageComment[] {
  return [{ by, body, where: "issue" }];
}

// Keeps the PR the implementer described and pushes its commits.
function finished(state: StageState, reply: ImplReply, by: Signature): Step {
  const st = {
    ...state.st,
    prTitle: clip(reply.prTitle, TITLE_LIMIT),
    prBody: clip(reply.prBody, BODY_LIMIT),
    prBy: by,
  };
  return launchStep({ ...state, st, phase: "pushed" }, [
    { kind: "op", name: "push", op: "push", payload: { number: state.n } },
  ]);
}

// Saves the pushed head and moves the issue to open-pr. A failed push is
// retried once unless git's push was rejected.
function pushed(state: StageState, results: readonly LaunchResult[]): Step {
  const { ok, error, headSha } = onlyReply(results);
  if (ok !== true || typeof headSha !== "string") {
    return pushFailedStep(
      state,
      "could not push the implementation",
      replyError(error),
    );
  }
  return doneStep({ ...state, st: { ...state.st, headSha, stage: "open-pr" } });
}

// Counts a handoff below the cap, so the next session continues from it. A
// handoff past the cap stops: the issue is too big for its sessions.
function handedOff(
  state: StageState,
  ctx: StageContext,
  reply: ImplReply,
  by: Signature,
): Step {
  if (mayContinue(state.st, ctx.cfg, "implement")) {
    return doneStep(
      { ...state, st: continued(state.st, "implement") },
      issueComment(
        by,
        `This session ran out of room before finishing. Another implementer session continues from its handoff.\n\n${reply.summary}`,
      ),
    );
  }
  return stopStep(
    state,
    outOfRoomReason(ROLE, ctx.cfg.maxContinuations),
    `Latest handoff: ${state.paths.handoffFile}\n\n${reply.summary}`,
    issueComment(by, reply.summary),
  );
}

// Acts on the session's status.
function decide(
  state: StageState,
  ctx: StageContext,
  results: readonly LaunchResult[],
): Step {
  const result = onlyChild(results);
  let reply: ImplReply | null = null;
  if (result.ok) {
    reply = implReplyOf(result.structuredOutput);
  }
  if (reply === null) {
    const reason = "the implementer session failed";
    return sessionFailedStep(state, reason, result.error, ctx.now());
  }
  const st = { ...state.st };
  noteEvent(st, `implement: ${reply.status} - ${reply.summary}`, ctx.now());
  const decided = { ...state, st };
  const { status } = reply;
  switch (status) {
    case "done":
      return finished(decided, reply, result.by);
    case "handoff":
      return handedOff(decided, ctx, reply, result.by);
    case "blocked":
      return stopStep(
        decided,
        "the implementer could not do the issue as written",
        reply.summary,
        issueComment(result.by, reply.summary),
      );
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

// Implement's next step, from its state and the results of its last launches.
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
    case "pushed":
    case "repushed":
      return pushed(state, results);
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
