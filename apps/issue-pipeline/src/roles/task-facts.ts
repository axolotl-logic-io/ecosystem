// The facts every session's task is built from. A task holds only this
// run's facts and the reply's shape: the behaviour each session follows is
// the wiki page the runtime pins and loads ahead of the task, by the
// session's stage and phase (author: Pipeline-Prompt-Author, implement:
// -Developer, review/hardening: -Hardening, merge/integration:
// -Integration, merge/security-review: -Security). The task's kind names
// the section of that page that applies. Pure.

import { JOB_DOCS, JOB_REPO } from "../job/layout.ts";
import type { RoleContext } from "../job/role-context.ts";

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

function wikiFact(ctx: RoleContext): string {
  if (ctx.dirs.docs === null) {
    return "Wiki checkout: none; the repo has no wiki";
  }
  return `Wiki checkout: \`${JOB_DOCS}/\`, on the issue's wiki branch`;
}

// A task's title, kind and where the issue and its checkouts are; `code`
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
      `Code checkout: \`${JOB_REPO}/\`, ${code}`,
      wikiFact(ctx),
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

// The issue's Gherkin, its assumptions and the wiki pages it names.
function gherkinLines(ctx: RoleContext): string[] {
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
  if (gherkin.wikiPages.length > 0) {
    lines.push("Wiki pages to update:", ...bullets(gherkin.wikiPages), "");
  }
  return lines;
}

// The reply's shape: one line per answer the schema takes.
function replyLines(answers: readonly string[]): string[] {
  return ["## Reply", "", ...bullets(answers), ""];
}

export type { TaskKind };
export { bullets, fullCheckLines, gherkinLines, header, replyLines };
