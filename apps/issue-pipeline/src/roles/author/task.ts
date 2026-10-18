// The author session's task.

import type { RoleContext } from "../../job/role-context.ts";
import { standingRules } from "../prompt-rules.ts";

function currentGherkin(ctx: RoleContext): string[] {
  const { gherkin } = ctx.inputs;
  if (gherkin === null) {
    return ["The issue has no Gherkin comment yet: write its first revision."];
  }
  return [
    `The issue's Gherkin comment is at revision ${gherkin.rev}:`,
    "",
    "```gherkin",
    gherkin.gherkin,
    "```",
    "",
    "The issue or its trusted comments changed since then. Update the Gherkin when the change needs it, and set `changed` to whether the behaviour differs; keep it as it is otherwise.",
  ];
}

function authorTask(ctx: RoleContext): string {
  const lines = [
    `# Author issue #${ctx.issue} in ${ctx.cfg.repo}`,
    "",
    `Read the issue in \`${ctx.issueFile}\`, the repo in \`repo/\` and the wiki in \`docs/\`. Then write the behaviour the issue asks for as Gherkin: one Feature with the Scenarios that pin it, in the words of the issue and the project.`,
    "",
    ...currentGherkin(ctx),
    "",
    "List your own calls under `assumptions` and the wiki pages the change should update under `wikiPages`. If the issue can't be written as behaviour without an answer only its author can give, reply `needs-info` with up to five questions instead.",
    "",
    "Don't split the issue, approve your own Gherkin, or write tests, stubs or files: you only read.",
    "",
    ...standingRules(ctx.cfg.baseBranch, false),
  ];
  return lines.join("\n");
}

export { authorTask };
