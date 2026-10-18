// The start sync's conflict resolver (#419; the wiki's
// Pipeline-Roles-Implementor, "Start sync"): today's writer with the fixer's
// model and budget, CIFIX_SCHEMA, and a task that resolves the commit the
// rebase stopped on and commits it with `pipeline_commit`, under the
// writers' commit rules (commitRulesOf). Unlike today's
// resolver (src/workflow/stages/conflict-target.ts, codeTask), it neither
// continues nor aborts the rebase: the role's `continue` does, and the
// resolver runs again for each commit that stops. A continuation leads with
// its predecessor's handoff. Pure.

import { sessionBudget } from "../../workflow/budget.ts";
import {
  commitRulesOf,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
  preamble,
} from "../../workflow/prompts.ts";
import { CIFIX_SCHEMA } from "../../workflow/schemas.ts";
import { syncOnto } from "../../workflow/stages/stacked.ts";
import type { SessionEffect } from "../machine.ts";
import type { ImplData } from "./locate.ts";
import { IMPL_AGENT } from "./locate.ts";

const RESOLVER_MINUTES = 45;
const SHORT_SHA = 12;
const TRAILER = "Pipeline-Agent: conflict resolver";
// What a resolver that runs out of room keeps of its work.
const KEEP =
  "commit the resolution you have if it builds, and leave the rebase in progress";

function taskLines(data: ImplData): string[] {
  const { cfg } = data.settings;
  const files = data.conflict?.files ?? [];
  const baseSha = data.conflict?.baseSha ?? "";
  const onto = syncOnto(data.conflict?.stackedOn ?? null, cfg.baseBranch);
  return [
    `The pipeline is rebasing this branch onto ${onto} (${baseSha.slice(0, SHORT_SHA)}), and the rebase stopped on conflicts in:`,
    files.map((file) => `- ${file}`).join("\n"),
    "",
    `Resolve the stopped commit. For each conflicting file, read what ${onto} changed (\`git diff $(git merge-base REBASE_HEAD ${baseSha}) ${baseSha} -- <file>\`) and what the stopped commit changed (\`git show REBASE_HEAD -- <file>\`), and write a resolution that keeps the intent of both, with no conflict markers left.`,
    ...commitRulesOf("pipeline_commit", {
      unit: "resolution",
      when: "as soon as no conflict markers are left in it",
      trailer: TRAILER,
      clearMessage: true,
    }),
    "Don't continue, skip or abort the rebase: the pipeline continues it after you return, and starts a resolver again if a later commit stops too.",
    `No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what ${onto} now does and re-apply this branch's change on top of it as far as it still makes sense, and say in your summary what you chose. Return \`cannot-fix\` only if you could not resolve the commit at all; a fresh resolver then tries again next job.`,
    NO_ARTIFICIAL_LOAD_RULE,
    handoffRule(data.settings.budgets, data.settings.paths.handoffFile, KEEP),
    "Return `fixed` once the resolution is committed, with a `summary` of what you chose.",
  ];
}

// The resolver session for the run's conflict, its attempt the conflict fix
// it is; a continuation after each handoff it has taken.
function resolverSession(data: ImplData): SessionEffect {
  const { cfg, budgets, models, paths } = data.settings;
  const role = `conflict resolver, attempt ${data.conflictFixes} of ${data.maxConflictFixes}`;
  const lead: string[] = [];
  if (data.resolverContinuations > 0) {
    lead.push(handoffLead(paths.handoffFile), "");
  }
  const intro = preamble(cfg, { n: data.issue, paths }, role);
  return {
    kind: "session",
    name: "conflicts",
    agent: IMPL_AGENT,
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    budgetRole: "fixer",
    tokenBudget: sessionBudget(budgets, "fixer"),
    attempt: data.conflictFixes,
    minutes: RESOLVER_MINUTES,
    writer: true,
    task: [...lead, ...intro, ...taskLines(data)].join("\n"),
  };
}

export { resolverSession };
