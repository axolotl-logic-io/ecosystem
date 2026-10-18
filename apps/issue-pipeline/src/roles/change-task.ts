// The text every writing session's task shares: where the change may go,
// the issue's checkouts and Gherkin, and the task of a session that fixes
// the checks the pipeline's verification failed. Pure.

import { JOB_DOCS, JOB_REPO } from "../job/layout.ts";
import type { RoleContext } from "../job/role-context.ts";
import type { CodeMerged, IssueState } from "../state.ts";
import type { Check } from "./op-replies.ts";
import { standingRules } from "./prompt-rules.ts";

// Where a change's work may go: the issue's code branch and its wiki; the
// wiki alone of a change that lives only there and has no PR; or, once its
// code merged (`codeMerged`), the wiki alone.
type Mode =
  | { kind: "branch" }
  | { kind: "wiki-change" }
  | { kind: "wiki-only"; merged: CodeMerged };

const MAX_TAIL = 3000;
const MAX_CHECKS = 20;
const SHORT_SHA = 12;

// The rule every session that fixes or hardens a change follows, so checks
// pass for the right reason.
const NO_WEAKENING_RULE =
  "Fix the underlying cause. Never make a check pass by weakening a requirement, an assertion, test coverage, a check command, or a lint or type rule. Change a test only when it is genuinely wrong, and give the evidence in your summary.";

// The mode of the change `state` describes, as the Reviewer finds it.
function changeModeOf(state: IssueState): Mode {
  if (state.codeMerged !== null) {
    return { kind: "wiki-only", merged: state.codeMerged };
  }
  if (state.pr === null && state.flows?.code !== true) {
    return { kind: "wiki-change" };
  }
  return { kind: "branch" };
}

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function wikiLine(ctx: RoleContext): string {
  if (ctx.dirs.docs === null) {
    return "This repo has no wiki checkout.";
  }
  return `The wiki checkout is \`${JOB_DOCS}/\`, on the issue's wiki branch.`;
}

// A task's title and where its checkouts are.
function header(ctx: RoleContext, what: string): string[] {
  return [
    `# ${what} issue #${ctx.issue} in ${ctx.cfg.repo}`,
    "",
    `The issue is in \`${ctx.issueFile}\`. The code checkout is \`${JOB_REPO}/\`, on the issue's branch. ${wikiLine(ctx)}`,
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

// What a session may change in `mode`, as a phrase.
function scopeOf(mode: Mode): string {
  if (mode.kind === "branch") {
    return "the code, the tests or the wiki";
  }
  return `the wiki in \`${JOB_DOCS}/\` only`;
}

function checkLines(check: Check): string[] {
  const lines = [`### ${check.id}: ${check.detail}`];
  if (check.log !== undefined) {
    lines.push(`Log: \`${check.log}\``);
  }
  if (check.tail !== undefined && check.tail !== "") {
    lines.push("```text", check.tail.slice(-MAX_TAIL), "```");
  }
  return [...lines, ""];
}

// The task of a session that fixes the checks that failed on the change.
function fixTask(
  ctx: RoleContext,
  mode: Mode,
  {
    failed,
    attempt,
    max,
  }: { failed: readonly Check[]; attempt: number; max: number },
): string {
  return [
    ...header(ctx, "Fix the failing checks of"),
    ...gherkinLines(ctx),
    `The pipeline checked the change, and these checks failed (fix attempt ${attempt} of ${max}):`,
    "",
    ...failed.slice(0, MAX_CHECKS).flatMap(checkLines),
    `Find the cause and fix it in ${scopeOf(mode)}, then commit. ${NO_WEAKENING_RULE}`,
    "",
    "Reply `done` with a `summary` of the fix. Reply `cannot` with the `reason` only when no change in the repo can fix them, such as an outside service's outage or missing credentials.",
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  ].join("\n");
}

export type { Mode };
export {
  bullets,
  changeModeOf,
  fixTask,
  gherkinLines,
  header,
  NO_WEAKENING_RULE,
  SHORT_SHA,
  scopeOf,
};
