// The implementor sessions' tasks: the work on the issue, a fix of the
// checks that failed after it, and the resolution of a stopped rebase. Pure.

import { JOB_DOCS, JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { CodeMerged, Finding, MergeReturn } from "../../state.ts";
import { standingRules } from "../prompt-rules.ts";
import type { Check } from "./op-replies.ts";

// Where the work may go: the issue's branch, or, once its code merged, the
// wiki alone (`codeMerged`).
type Mode = { kind: "branch" } | { kind: "wiki-only"; merged: CodeMerged };

// Which checkout a stopped rebase is in.
type Side = "code" | "wiki";

const MAX_TAIL = 3000;
const MAX_CHECKS = 20;
const SHORT_SHA = 12;

function bullets(items: readonly string[]): string[] {
  return items.map((item) => `- ${item}`);
}

function wikiLine(ctx: RoleContext): string {
  if (ctx.dirs.docs === null) {
    return "This repo has no wiki checkout.";
  }
  return `The wiki checkout is \`${JOB_DOCS}/\`, on the issue's wiki branch.`;
}

function header(ctx: RoleContext, what: string): string[] {
  return [
    `# ${what} issue #${ctx.issue} in ${ctx.cfg.repo}`,
    "",
    `The issue is in \`${ctx.issueFile}\`. The code checkout is \`${JOB_REPO}/\`, on the issue's branch. ${wikiLine(ctx)}`,
    "",
  ];
}

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

function modeLines(mode: Mode): string[] {
  if (mode.kind === "wiki-only") {
    const { pr, sha } = mode.merged;
    return [
      `The issue's code already merged, as PR #${pr} (merge commit ${sha.slice(0, SHORT_SHA)}). Only its wiki work remains: change only \`${JOB_DOCS}/\`, and commit nothing in \`${JOB_REPO}/\`, since the pipeline pushes no code for this issue any more.`,
    ];
  }
  return [
    "The branch may already hold work on this issue, from an earlier round or from an earlier version of the pipeline. Start from it: keep what fits the Gherkin, and change or remove the rest.",
    "Write the code and the tests the Gherkin needs, and run the relevant tests.",
    `Update the wiki pages in \`${JOB_DOCS}/\` that the change affects; that is part of the work.`,
    "You may fix other breakage you find and simplify the code you work in, each as its own commit.",
  ];
}

// The task of the session that does the issue's work.
function workTask(ctx: RoleContext, mode: Mode): string {
  return [
    ...header(ctx, "Implement"),
    ...gherkinLines(ctx),
    ...findingLines(ctx),
    ...mergeReturnLines(ctx.state.mergeReturn),
    "## Work",
    "",
    ...bullets(modeLines(mode)),
    "",
    "When the work already on the branch does all the Gherkin says, commit nothing and say so in your summary.",
    "",
    "Reply `done` with a `summary` of the change once it is committed: the pipeline then verifies it, and the summary becomes the PR's description. Reply `cannot` with the `reason` only when the issue can't be done as written.",
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  ].join("\n");
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

// The task of a session that fixes the checks the job's verification failed.
function fixTask(
  ctx: RoleContext,
  mode: Mode,
  {
    failed,
    attempt,
    max,
  }: { failed: readonly Check[]; attempt: number; max: number },
): string {
  let scope = "the code, the tests or the wiki";
  if (mode.kind === "wiki-only") {
    scope = `the wiki in \`${JOB_DOCS}/\` only`;
  }
  return [
    ...header(ctx, "Fix the failing checks of"),
    ...gherkinLines(ctx),
    `The pipeline verified the branch after the work, and these checks failed (fix attempt ${attempt} of ${max}):`,
    "",
    ...failed.slice(0, MAX_CHECKS).flatMap(checkLines),
    `Find the cause and fix it in ${scope}, then commit. Reply \`done\` with a \`summary\` of the fix. Reply \`cannot\` with the \`reason\` only when no change in the repo can fix them, such as an outside service's outage or missing credentials.`,
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  ].join("\n");
}

// Each side's checkout in the job's folder.
const SIDE_DIRS: Readonly<Record<Side, string>> = {
  code: JOB_REPO,
  wiki: JOB_DOCS,
};

function ontoOf(ctx: RoleContext, side: Side): string {
  if (side === "code") {
    return `origin/${ctx.cfg.baseBranch}`;
  }
  return "the wiki's latest version";
}

// The task of a session that resolves a rebase stopped on conflicts.
function resolverTask(
  ctx: RoleContext,
  side: Side,
  conflict: {
    conflicts: readonly string[];
    baseSha: string;
    attempt: number;
    max: number;
    rejected: string | null;
  },
): string {
  const { [side]: dir } = SIDE_DIRS;
  const onto = ontoOf(ctx, side);
  const lines = [
    ...header(ctx, "Resolve the rebase conflicts of"),
    `The pipeline is rebasing the issue's branch in \`${dir}/\` onto ${onto} (${conflict.baseSha.slice(0, SHORT_SHA)}), and the rebase stopped on conflicts in:`,
    "",
    ...bullets(conflict.conflicts),
    "",
    `For each stopped commit, read what ${onto} changed in the conflicting files and what the stopped commit changed (\`git -C ${dir} show REBASE_HEAD\`), and write a resolution that keeps the intent of both, with no conflict markers left. Then stage only the files you resolved, with \`git -C ${dir} add -- <file>\`, and run \`GIT_EDITOR=true git -C ${dir} rebase --continue\`. Repeat until the rebase finishes.`,
    "",
    "Besides reading commands such as `git show`, those two are the only git commands you may run, and only for this rebase: replaying the stopped commits is not leave to make any other commit. Never skip, abort or reset the rebase, and never pass `--no-verify`. Make no other change here; the work session after the sync does that.",
    "",
    `No human resolves conflicts, so decide them yourself. When the two sides contradict each other, keep what ${onto} now does and re-apply the branch's change on top of it as far as it still makes sense, and say in your summary what you chose.`,
    "",
  ];
  if (conflict.rejected !== null) {
    lines.push(
      "The pipeline rejected the last resolution of this rebase:",
      "",
      conflict.rejected,
      "",
    );
  }
  lines.push(
    `This is resolution attempt ${conflict.attempt} of ${conflict.max}. Reply \`conflict-resolved\` with a \`summary\` once the rebase has finished, or \`cannot-fix\` with a \`summary\` when you could not finish it; the pipeline checks the result either way.`,
    "",
    ...standingRules(ctx.cfg.baseBranch, true),
  );
  return lines.join("\n");
}

export type { Mode, Side };
export { fixTask, resolverTask, workTask };
