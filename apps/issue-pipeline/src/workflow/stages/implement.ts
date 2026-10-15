// Implement: one writer session builds the issue to its spec, tests and
// commits it. A session that runs out of room hands off to one continuation;
// the sweep begins the stage again for it. A done issue moves to open-pr.

import { chargeSession } from "../budget.ts";
import { clip } from "../clip.ts";
import { noteEvent } from "../event-log.ts";
import { practicesNote, preamble } from "../prompts.ts";
import { IMPL_SCHEMA } from "../schemas.ts";
import type { Signature } from "../signing.ts";
import type { ImplReply } from "./build-replies.ts";
import { implReplyOf } from "./build-replies.ts";
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
// The continuation sessions an issue may have.
const MAX_CONTINUATIONS = 1;

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
  if ((st.continuations ?? 0) > 0) {
    return `A previous session ran out of room. Read its handoff first: ${paths.handoffFile}. Continue from the current branch state.`;
  }
  if (isSet(st.spec)) {
    return `Spec (also posted on the issue):\n${st.spec}`;
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
    "4. Commit everything with clear messages (`git add -A && git commit`), ending each message with the trailer line `Pipeline-Agent: implementer`. Leave the worktree clean.",
    wikiStep(state.paths.wiki),
    "Change lockfiles only through the package manager, never by hand.",
    "",
    `If the work is bigger than this session can finish within budget (for example, you have read more than about 15 files or made more than about 30 substantial tool calls and are not close), stop: commit what builds, write ${state.paths.handoffFile} (what is done, what is left, current branch state), and return status \`handoff\`.`,
    "Return `blocked` only if the issue cannot be done as written; explain in `summary`.",
    "`prTitle` and `prBody` describe the change for reviewers (body: what changed and why, and how it is tested).",
  ];
  return preamble(cfg, state, ROLE, budgets.sessionCap)
    .concat(lines)
    .join("\n");
}

function implementLaunch(state: StageState, ctx: StageContext): ChildLaunch {
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
    task: implementTask(state, ctx),
  };
}

// Charges the session, then launches it.
function begin(state: StageState, ctx: StageContext): Step {
  const st = { ...state.st };
  const charge = chargeSession(ctx.budgets, st, "implementer");
  if (!charge.charged) {
    return stopStep(state, "issue token budget exhausted", charge.detail);
  }
  const charged = { ...state, st };
  return launchStep({ ...charged, phase: "decide" }, [
    implementLaunch(charged, ctx),
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

// Counts the first handoff, so the next session continues from it. A second
// handoff stops: the issue is too big for its sessions.
function handedOff(state: StageState, reply: ImplReply, by: Signature): Step {
  const continuations = state.st.continuations ?? 0;
  if (continuations < MAX_CONTINUATIONS) {
    const st = { ...state.st, continuations: continuations + 1 };
    return doneStep(
      { ...state, st },
      issueComment(
        by,
        `This session ran out of room before finishing. A second implementer session continues from its handoff.\n\n${reply.summary}`,
      ),
    );
  }
  return stopStep(
    state,
    "the implementer ran out of room twice; the issue needs splitting",
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
      return handedOff(decided, reply, result.by);
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
