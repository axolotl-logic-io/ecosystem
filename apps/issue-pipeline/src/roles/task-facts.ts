// The facts every session's task is built from. A task holds only this
// run's facts and the reply's shape: the behaviour each session follows is
// the prompt page the runtime pins and loads ahead of the task, by the
// session's stage and phase (prompts/ in the pipeline: author: author.md,
// implement: developer.md, review/hardening: hardening.md,
// merge/integration: integration.md, merge/security-review: security.md).
// The task's kind names the section of that page that applies. Pure.

import { JOB_REPO } from "../job/layout.ts";
import type { RoleContext } from "../job/role-context.ts";
import { usedAuthor } from "../requirements.ts";

// What a session is asked to do, as its page's sections name it.
type TaskKind =
  | "authoring"
  | "development"
  | "hardening"
  | "check-fix"
  | "conflict-resolution"
  | "security-review";

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

// A task's title, kind and where the issue and its checkout are; `code`
// says what the code checkout holds when it isn't the issue's branch.
function header(
  ctx: RoleContext,
  kind: TaskKind,
  code = "on the issue's branch",
): string[] {
  return [
    `# Issue #${ctx.issue} in ${ctx.cfg.repo}: \`${kind}\``,
    "",
    ...bullets([
      `Task: \`${kind}\``,
      `Issue file: \`${ctx.issueFile}\``,
      `Code checkout: \`${JOB_REPO}/\`, ${code}; the repo's docs are in \`${JOB_REPO}/docs/\``,
      `Base branch: \`${ctx.cfg.baseBranch}\``,
    ]),
    "",
  ];
}

// The actual full gate, not an example or a command inferred by the model.
function fullCheckLines(ctx: RoleContext): string[] {
  return [
    "## Configured full check (deterministic verification)",
    "",
    `commands.test: ${JSON.stringify(ctx.cfg.commands.test)}`,
    "",
  ];
}

// The trusted requirements source and optional Author output.
function requirementsLines(ctx: RoleContext): string[] {
  if (!usedAuthor(ctx.state)) {
    return [
      "## Requirements",
      "",
      `Source: issue title, body and trusted collaborator comments in ${ctx.issueFile}`,
      `Trusted-input revision: ${ctx.inputs.revision}`,
      "",
    ];
  }
  const { gherkin } = ctx.inputs;
  if (gherkin === null) {
    return [];
  }
  const lines = [
    `## Behaviour (Gherkin revision ${gherkin.rev})`,
    "",
    "```gherkin",
    gherkin.gherkin,
    "```",
    "",
  ];
  if (gherkin.assumptions.length > 0) {
    lines.push("Assumptions:", ...bullets(gherkin.assumptions), "");
  }
  return lines;
}

// The reply's shape: one line per answer the schema takes.
function replyLines(answers: readonly string[]): string[] {
  return ["## Reply", "", ...bullets(answers), ""];
}

export type { TaskKind };
export { bullets, fullCheckLines, header, replyLines, requirementsLines };
