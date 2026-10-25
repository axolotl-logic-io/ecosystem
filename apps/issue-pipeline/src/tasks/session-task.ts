// The facts a task's model session is given: its kind, the issue file, the
// checkout and the exact binding. The behaviour each session follows is the
// prompt page the runtime loads for its agent and phase (prompts/:
// developer.md, developer-hardening.md, sync.md, security.md); the kind
// names that page's section. Its reply's shape is the session's schema.

import type { ActionContext } from "../domain.ts";
import { isRevisionBinding } from "../domain.ts";
import { writeIssueContext } from "../issue-context.ts";

type SessionKind =
  | "development"
  | "hardening"
  | "conflict-resolution"
  | "security-review";

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function bindingLines(ctx: ActionContext): string[] {
  const { binding } = ctx;
  if (!isRevisionBinding(binding)) {
    return [`Trusted requirements: ${binding.requirements}`];
  }
  return [
    `Revision: code ${binding.revision.code}, trusted inputs ${binding.revision.inputs}`,
    `Target: ${binding.target.branch} at ${binding.target.commit}`,
  ];
}

// The session's task text; it writes the issue file it names.
function sessionTask(
  ctx: ActionContext,
  kind: SessionKind,
  extra: readonly string[] = [],
): string {
  const { file } = writeIssueContext(ctx.cfg, ctx.workItem.number);
  return [
    `# Issue #${ctx.workItem.number} in ${ctx.workItem.repo}: \`${kind}\``,
    "",
    ...bullets([
      `Task: \`${kind}\``,
      `Issue file: \`${file}\``,
      `Code checkout: \`${ctx.checkout.repo}\`, on branch \`${ctx.checkout.branch}\``,
      `Target branch: \`${ctx.cfg.baseBranch}\``,
      ...bindingLines(ctx),
    ]),
    "",
    "## Configured full check",
    "",
    `commands.test: ${JSON.stringify(ctx.cfg.commands.test)}`,
    "",
    ...extra,
  ].join("\n");
}

export type { SessionKind };
export { sessionTask };
