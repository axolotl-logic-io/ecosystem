// The task of the Reviewer's hardening, the review stage's one session: it
// writes, and owns the change's design, correctness and tests. Pure.

import { JOB_DOCS, JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { Mode } from "../change-task.ts";
import {
  bullets,
  gherkinLines,
  header,
  NO_WEAKENING_RULE,
  scopeOf,
} from "../change-task.ts";
import { standingRules } from "../prompt-rules.ts";

function changeLines(ctx: RoleContext, mode: Mode): string[] {
  const base = `origin/${ctx.cfg.baseBranch}`;
  if (mode.kind === "wiki-only") {
    return [
      `The issue's code already merged, as PR #${mode.merged.pr}. Only its wiki change in \`${JOB_DOCS}/\` remains, and it must describe the merged code in \`${JOB_REPO}/\` truly. Commit nothing in \`${JOB_REPO}/\`.`,
    ];
  }
  if (mode.kind === "wiki-change") {
    return [
      `The change lives only in the wiki, in \`${JOB_DOCS}/\`. Commit nothing in \`${JOB_REPO}/\`.`,
    ];
  }
  return [
    `The Developer's change is the issue branch in \`${JOB_REPO}/\` against \`${base}\` (\`git -C ${JOB_REPO} diff ${base}...HEAD\`), with its wiki change in \`${JOB_DOCS}/\`.`,
  ];
}

// The task of the hardening session, which owns the change's design,
// correctness and tests before the final review.
function hardeningTask(ctx: RoleContext, mode: Mode): string {
  return [
    ...header(ctx, "Harden"),
    ...gherkinLines(ctx),
    "## Hardening",
    "",
    ...changeLines(ctx, mode),
    "",
    "You own this change's design, correctness and tests from here. Once it passes, the pipeline merges it, and the only later review judges the merged result's security alone, so leave nothing about design, correctness or tests for it.",
    "",
    ...bullets([
      "Examine the Gherkin and the change adversarially: what it misses, what it breaks, and the edge cases and failures it doesn't handle.",
      "Check that it follows `AGENTS.md` and the wiki's Decisions pages.",
      "Add the regression and edge-case tests that pin what the Gherkin says and would fail without the change.",
      `Fix the defects you find at their cause, in ${scopeOf(mode)}, and commit each fix.`,
      "Run the checks your changes touch. The pipeline then runs the repo's configured checks and the wiki checks on what you committed.",
      "Work on the branch as you find it: never rebase it, merge its base into it or otherwise bring it up to date; the pipeline does that at merge.",
    ]),
    "",
    NO_WEAKENING_RULE,
    "",
    "Where the Gherkin is ambiguous about the product, don't invent a requirement: reply `cannot` with the `reason` naming the question, and the issue stops for a person.",
    "",
    "Reply `done` with a `summary` of what you examined, the tests you added and the defects you fixed, once it is committed. When the change needs nothing more, commit nothing and say why.",
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  ].join("\n");
}

export { hardeningTask };
