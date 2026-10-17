// The implementer's session: its agent, model, context budget, reply schema
// and task (the wiki's Pipeline-Roles-Implementor, "Implement"). The task is
// today's implement stage's, for a stage job: the practices, what to build
// from (the spec, or triage's plan), the steps, the load rule, the commit
// rules and the context limits, with no PR text (`spec-writer-opens-pr`)
// and no wiki step, since the spec writer commits the wiki updates. A
// continuation's task leads with its predecessor's handoff. Pure.

import { sessionBudget } from "../../workflow/budget.ts";
import {
  beyondIssueRule,
  commitRulesOf,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
  practicesNote,
  preamble,
  specText,
} from "../../workflow/prompts.ts";
import { commandsClause } from "../../workflow/stages/implement-steps.ts";
import type { SessionEffect } from "../machine.ts";
import type { ImplData } from "./locate.ts";
import { IMPL_AGENT, IMPL_ROLE } from "./locate.ts";
import { IMPL_SCHEMA } from "./reply.ts";

// The spec's documented test and stub files the branch lacked at a restart,
// as a lead for the session; none when there are none.
function unwrittenLines(files: readonly string[]): string[] {
  if (files.length === 0) {
    return [];
  }
  const named = files.map((file) => `\`${file}\``).join(", ");
  return [
    `The spec documents these test or stub files, which the branch lacks; write them as part of this work: ${named}.`,
    "",
  ];
}

// What the session works from: the spec, with the handoff of a session
// before a restart, if any (`every-role-resumes`), or triage's plan.
function sourceLine(data: ImplData, continued: boolean): string {
  const spec = specText({
    spec: data.spec ?? null,
    specFile: data.specFile ?? null,
  });
  if (spec === "") {
    return `Triage plan:\n${data.plan ?? "(none)"}`;
  }
  const specLine = `Spec (also posted on the issue):\n${spec}`;
  if (continued) {
    return specLine;
  }
  return `If ${data.settings.paths.handoffFile} exists, an earlier implementer session of this issue wrote it before the issue stopped: read it and the commits on the branch first, and build on them.\n\n${specLine}`;
}

function taskLines(data: ImplData, continued: boolean): string[] {
  const { cfg, budgets, paths } = data.settings;
  return [
    practicesNote(cfg, { n: data.issue, paths }, "writer"),
    ...unwrittenLines(data.unwrittenFiles),
    sourceLine(data, continued),
    "",
    "Do this:",
    "1. Write or update tests that specify the fix. They must fail without your change.",
    "2. Implement the change that resolves the issue.",
    `3. Run the tests${commandsClause(cfg.commands)} and fix failures.`,
    "4. Commit as you go (see below), and commit what is left at the end. Leave the worktree clean.",
    "Change lockfiles only through the package manager, never by hand.",
    beyondIssueRule(cfg.baseBranch, "`summary`"),
    NO_ARTIFICIAL_LOAD_RULE,
    "",
    ...commitRulesOf("pipeline_commit", {
      unit: "step",
      when: "as soon as it builds and its tests pass",
      trailer: "Pipeline-Agent: implementer",
      clearMessage: true,
    }),
    handoffRule(budgets, paths.handoffFile, "make it build and commit it"),
    "Return `blocked` only if the issue cannot be done as written; explain in `summary`.",
    "Return `done` once your work is committed, with a `summary` for reviewers: what changed and why, how it is tested, and each fix or improvement beyond the issue.",
  ];
}

// The implementer session for the run's data: a continuation after each
// handoff it has taken.
function implementerSession(data: ImplData): SessionEffect {
  const { cfg, budgets, models, paths } = data.settings;
  const continued = data.continuations > 0;
  const lead: string[] = [];
  if (continued) {
    lead.push(handoffLead(paths.handoffFile), "");
  }
  const intro = preamble(cfg, { n: data.issue, paths }, IMPL_ROLE);
  return {
    kind: "session",
    name: "implement",
    agent: IMPL_AGENT,
    model: models.implementer,
    schema: IMPL_SCHEMA,
    budgetRole: "implementer",
    tokenBudget: sessionBudget(budgets, "implementer"),
    attempt: data.continuations + 1,
    task: [...lead, ...intro, ...taskLines(data, continued)].join("\n"),
  };
}

export { implementerSession };
