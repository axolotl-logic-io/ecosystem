// A writing session's change: where it may go (its mode and scope, as task
// facts), and the task of a session that fixes the checks the pipeline's
// verification failed. Pure.

import { JOB_DOCS, JOB_REPO } from "../job/layout.ts";
import type { RoleContext } from "../job/role-context.ts";
import type { CodeMerged, IssueState } from "../state.ts";
import type { Check } from "./op-replies.ts";
import {
  fullCheckLines,
  gherkinLines,
  header,
  replyLines,
} from "./task-facts.ts";

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

// The mode of the change `state` describes.
function changeModeOf(state: IssueState): Mode {
  if (state.codeMerged !== null) {
    return { kind: "wiki-only", merged: state.codeMerged };
  }
  if (state.pr === null && state.flows?.code !== true) {
    return { kind: "wiki-change" };
  }
  return { kind: "branch" };
}

// The scope of a session's work in `mode`, as the task's facts.
function scopeLines(ctx: RoleContext, mode: Mode): string[] {
  if (mode.kind === "wiki-only") {
    const { pr, sha } = mode.merged;
    return [
      `Scope: the wiki in \`${JOB_DOCS}/\` only. The code already merged as PR #${pr}, merge commit \`${sha}\`, which \`${JOB_REPO}/\` holds: commit nothing in \`${JOB_REPO}/\`.`,
      "",
    ];
  }
  if (mode.kind === "wiki-change") {
    return [
      `Scope: the wiki in \`${JOB_DOCS}/\` only. The change lives only in the wiki and has no PR: commit nothing in \`${JOB_REPO}/\`.`,
      "",
    ];
  }
  const base = `origin/${ctx.cfg.baseBranch}`;
  return [
    `Scope: the code branch in \`${JOB_REPO}/\` and the wiki in \`${JOB_DOCS}/\`. The change: \`git -C ${JOB_REPO} diff ${base}...HEAD\`.`,
    "",
  ];
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
    ...header(ctx, "check-fix"),
    ...scopeLines(ctx, mode),
    ...fullCheckLines(ctx),
    ...gherkinLines(ctx),
    `## Failed checks (fix attempt ${attempt} of ${max})`,
    "",
    ...failed.slice(0, MAX_CHECKS).flatMap(checkLines),
    ...replyLines([
      "`done`, with a `summary` of the fix, once it is committed.",
      "`cannot`, with the `reason`.",
    ]),
  ].join("\n");
}

export type { Mode };
export { changeModeOf, fixTask, SHORT_SHA, scopeLines };
