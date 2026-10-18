// The `checks` entry's sessions (the wiki's Pipeline-Roles-Implementor,
// "Entry `checks`"): the CI fixer, which fixes the failing checks with a
// continuation after each handoff, and the two check-fix reviewers, which
// read only the fix's diff. Their tasks are today's checks stage's
// (stages/ci-fixer.ts and stages/ci-fix.ts), for a stage job. A
// continuation's task leads with its predecessor's handoff. Pure.

import { sessionBudget } from "../../workflow/budget.ts";
import { LENSES } from "../../workflow/lenses.ts";
import { practicesNote } from "../../workflow/practices.ts";
import {
  beyondIssueRule,
  commitRulesOf,
  handoffLead,
  handoffRule,
  NO_ARTIFICIAL_LOAD_RULE,
  preamble,
} from "../../workflow/prompts.ts";
import { REVIEW_SCHEMA } from "../../workflow/review-schemas.ts";
import { CIFIX_SCHEMA } from "../../workflow/schemas.ts";
import type { Signature } from "../../workflow/signing.ts";
import type { SessionEffect } from "../machine.ts";
import type { FixLens } from "./checks-data.ts";
import type { ImplData } from "./locate.ts";
import { IMPL_AGENT } from "./locate.ts";

// The agent the check-fix reviewers run as, which can't edit the checkout.
const REVIEWER_AGENT = "issue-pipeline-reader";

// Whether the fixer's session continues its predecessor's handoff: the
// last fix of this round handed off.
function continuesHandoff(data: ImplData): boolean {
  return data.fix?.status === "handoff";
}

// Who signs the fixer's comments: the fixer, by its attempt.
function fixerBy(data: ImplData): Signature {
  return {
    role: `check fixer (attempt ${data.ciFixRounds})`,
    agent: IMPL_AGENT,
    model: data.settings.models.fixer,
    run: data.by.run,
  };
}

function fixerLines(data: ImplData): string[] {
  const { cfg, budgets, paths } = data.settings;
  return [
    practicesNote(cfg, { n: data.issue, paths }, "writer"),
    "These checks failed:",
    data.failure ?? "",
    "",
    "Fix every failing check, whatever caused it, even when this change didn't: a flaky check is a failure, so fix its cause and never just re-run it. If `fails-before-fix` failed, the tests do not prove the change: strengthen them so they fail without the fix. If a lockfile check failed, regenerate the lockfile with the package manager.",
    ...commitRulesOf("pipeline_commit", {
      unit: "step",
      when: "as soon as it works",
      trailer: "Pipeline-Agent: check fixer",
      clearMessage: false,
    }),
    "Run the failing check locally, commit what is left and leave the worktree clean. Return `cannot-fix` only for a failure no change in the repo can fix: an outage of an outside service, missing secrets or credentials, or anything that needs the repo's owner. Say which in `summary`.",
    beyondIssueRule(cfg.baseBranch, "`summary`, which is posted on the PR"),
    NO_ARTIFICIAL_LOAD_RULE,
    handoffRule(budgets, paths.handoffFile, "make it build and commit it"),
  ];
}

// The CI fixer's session for the round in data: `cifix-<round>`, and
// `-c<k>` for the kth continuation, counted across rounds.
function ciFixerSession(data: ImplData): SessionEffect {
  const { cfg, budgets, models, paths } = data.settings;
  const round = data.ciFixRounds;
  let name = `cifix-${round}`;
  const lead: string[] = [];
  if (continuesHandoff(data)) {
    name = `${name}-c${data.ciFixContinuations}`;
    lead.push(handoffLead(paths.handoffFile), "");
  }
  const role = `check fixer, attempt ${round} of ${data.maxCiFixes}`;
  const intro = preamble(cfg, { n: data.issue, paths }, role);
  return {
    kind: "session",
    name,
    agent: IMPL_AGENT,
    model: models.fixer,
    schema: CIFIX_SCHEMA,
    budgetRole: "ciFixer",
    tokenBudget: sessionBudget(budgets, "ciFixer"),
    attempt: round,
    task: [...lead, ...intro, ...fixerLines(data)].join("\n"),
  };
}

// The session of the check-fix reviewer for `lens`, on the round's diff.
function fixReviewSession(lens: FixLens): (data: ImplData) => SessionEffect {
  return (data: ImplData): SessionEffect => {
    const { cfg, budgets, models, paths } = data.settings;
    const role = `check-fix reviewer (${lens})`;
    const intro = preamble(cfg, { n: data.issue, paths }, role);
    const lines = [
      `Concern: ${LENSES[lens]}`,
      `Review only the diff at ${data.diffPath ?? ""}, which fixed failing checks after the PR passed review. Report only blocking defects this diff introduced. Do not edit files.`,
    ];
    return {
      kind: "session",
      name: `cifix-review-${lens}-${data.ciFixRounds}`,
      agent: REVIEWER_AGENT,
      model: models[lens],
      schema: REVIEW_SCHEMA,
      budgetRole: "rereviewer",
      tokenBudget: sessionBudget(budgets, "rereviewer"),
      attempt: data.ciFixRounds,
      task: [...intro, ...lines].join("\n"),
    };
  };
}

export { ciFixerSession, fixerBy, fixReviewSession, REVIEWER_AGENT };
