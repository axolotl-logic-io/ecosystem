// The author session's task: the issue's facts and its current Gherkin. The
// Author's behaviour is its prompt page (task-facts.ts). Pure.

import { JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import { header, replyLines } from "../task-facts.ts";

function currentGherkin(ctx: RoleContext): string[] {
  const { gherkin } = ctx.inputs;
  if (gherkin === null) {
    return ["The issue has no Gherkin comment yet.", ""];
  }
  return [
    `## Current Gherkin (revision ${gherkin.rev})`,
    "",
    "The issue or its trusted comments changed since this revision.",
    "",
    "```gherkin",
    gherkin.gherkin,
    "```",
    "",
  ];
}

function authorTask(ctx: RoleContext): string {
  return [
    ...header(ctx, "authoring"),
    `Read: the issue and the repo in \`${JOB_REPO}/\`, including its docs in \`${JOB_REPO}/docs/\`.`,
    "",
    ...currentGherkin(ctx),
    ...replyLines([
      "`gherkin`, with the `gherkin` text, your `assumptions`, and `changed`: whether the behaviour differs from the current Gherkin.",
      "`needs-info`, with up to five `questions`.",
    ]),
  ].join("\n");
}

export { authorTask };
