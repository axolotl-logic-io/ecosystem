// Implement: one writer session builds the issue to its spec, tests and
// commits it. A session that runs out of room hands off to a continuation, up
// to config maxContinuations; the sweep begins the stage again for each. A
// done issue moves to open-pr.

import { sessionBudget } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import {
  commitOftenRule,
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
import { doneStep, launchStep, onlyChild, stopStep } from "./step.ts";
import type {
  ChildLaunch,
  LaunchResult,
  StageCommands,
  StageComment,
  StageContext,
  StageState,
  Step,
} from "./types.ts";

// Where implement is: about to launch the session, or reading its reply.
type ImplementPhase = "begin" | "decide";

const PHASES: readonly ImplementPhase[] = ["begin", "decide"];

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

function isSet(text: string | null | undefined): text is string {
  return typeof text === "string" && text !== "";
}

// What the session works from: the handoff, the spec, or triage's plan.
function sourceLine(state: StageState): string {
  const { st, paths } = state;
  if (continuationsOf(st, "implement") > 0) {
    return handoffLead(paths.handoffFile);
  }
  const spec = specText(st);
  if (spec !== "") {
    return `Spec (also posted on the issue):\n${spec}`;
  }
  return `Triage plan:\n${String(st.plan)}`;
}

// The configured commands the session runs, as a clause of step 3.
function commandsClause(commands: StageCommands): string {
  let clause = "";
  if (isSet(commands.test)) {
    clause += ` (\`${commands.test}\`)`;
  }
  if (isSet(commands.lint)) {
    clause += `, lint (\`${commands.lint}\`)`;
  }
  if (isSet(commands.typecheck)) {
    clause += `, and typecheck (\`${commands.typecheck}\`)`;
  }
  return clause;
}

// The step that commits the wiki updates, or "" when there is no wiki.
function wikiStep(wiki: string | null): string {
  if (!isSet(wiki)) {
    return "";
  }
  return `5. Make the wiki updates the spec lists, and record any new design decision, in the wiki checkout: edit its pages, then commit there (\`git -C ${wiki} add -A && git -C ${wiki} commit\`, same trailer). Leave it clean too. Reviewers see those commits, and they reach the wiki when the PR merges.`;
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
    wikiStep(state.paths.wiki),
    "Change lockfiles only through the package manager, never by hand.",
    "",
    commitOftenRule(
      "commit each step with `git add -A && git commit` and a clear message as soon as it builds and its tests pass, ending each message with the trailer line `Pipeline-Agent: implementer`",
    ),
    handoffRule(
      budgets.hardLimit,
      state.paths.handoffFile,
      "commit what builds",
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

// Keeps the PR the implementer described and moves the issue to open-pr.
function finished(state: StageState, reply: ImplReply, by: Signature): Step {
  const st = {
    ...state.st,
    prTitle: clip(reply.prTitle, TITLE_LIMIT),
    prBody: clip(reply.prBody, BODY_LIMIT),
    prBy: by,
    stage: "open-pr",
  };
  return doneStep({ ...state, st });
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
    return stopStep(state, "the implementer session failed", result.error);
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
    default: {
      const unhandled: never = phase;
      return unhandled;
    }
  }
}

export { next };
