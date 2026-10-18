// The Developer session's task: the work on the issue, from the Gherkin and
// what an earlier round left for it. Pure.

import { JOB_DOCS, JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { Finding, MergeReturn } from "../../state.ts";
import type { Mode } from "../change-task.ts";
import { bullets, gherkinLines, header, SHORT_SHA } from "../change-task.ts";
import { standingRules } from "../prompt-rules.ts";

// Where the Developer's work may go: the issue's branch, or, once its code
// merged, the wiki alone.
type DevelopmentMode = Exclude<Mode, { kind: "wiki-change" }>;

function whereOf(finding: Finding): string {
  if (finding.path === undefined) {
    return "";
  }
  if (finding.line === undefined) {
    return ` (${finding.path})`;
  }
  return ` (${finding.path}:${finding.line})`;
}

function findingLine(finding: Finding): string {
  const where = whereOf(finding);
  return `${finding.id}. [${finding.severity}]${where} ${finding.text}`;
}

function findingLines(ctx: RoleContext): string[] {
  const { verdict, findings } = ctx.state.review;
  if (verdict !== "changes" || findings.length === 0) {
    return [];
  }
  return [
    "## Review findings",
    "",
    "The last review asked for changes. Answer every blocking finding; take the notes where they help:",
    "",
    ...findings.map(findingLine),
    "",
  ];
}

function mergeReturnLines(mergeReturn: MergeReturn | null): string[] {
  if (mergeReturn === null) {
    return [];
  }
  return [
    "## Sent back from merge",
    "",
    `The merge stage sent the issue back (${mergeReturn.reason}):`,
    "",
    mergeReturn.detail,
    "",
  ];
}

function modeLines(mode: DevelopmentMode): string[] {
  if (mode.kind === "wiki-only") {
    const { pr, sha } = mode.merged;
    return [
      `The issue's code already merged, as PR #${pr} (merge commit ${sha.slice(0, SHORT_SHA)}). Only its wiki work remains: change only \`${JOB_DOCS}/\`, and commit nothing in \`${JOB_REPO}/\`, since the pipeline pushes no code for this issue any more.`,
    ];
  }
  return [
    "The branch may already hold work on this issue, from an earlier round or from an earlier version of the pipeline. Start from it: keep what fits the Gherkin, and change or remove the rest.",
    "Write the code and the tests the Gherkin needs, and run the tests your change touches. The Reviewer then hardens the change and runs the repo's full checks, so you need not run them all.",
    `Update the wiki pages in \`${JOB_DOCS}/\` that the change affects; that is part of the work.`,
    "Work on the branch as you find it: never rebase it, merge its base into it or otherwise bring it up to date; the pipeline does that at merge.",
    "You may fix other breakage you find and simplify the code you work in, each as its own commit.",
  ];
}

// The task of the Developer's session, which does the issue's work.
function workTask(ctx: RoleContext, mode: DevelopmentMode): string {
  return [
    ...header(ctx, "Develop"),
    ...gherkinLines(ctx),
    ...findingLines(ctx),
    ...mergeReturnLines(ctx.state.mergeReturn),
    "## Work",
    "",
    ...bullets(modeLines(mode)),
    "",
    "When the work already on the branch does all the Gherkin says, commit nothing and say so in your summary.",
    "",
    "Reply `done` with a `summary` of the change once it is committed: the pipeline pushes it to the issue's draft PR, and the summary becomes the PR's description. Reply `cannot` with the `reason` only when the issue can't be done as written.",
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  ].join("\n");
}

export type { DevelopmentMode };
export { workTask };
