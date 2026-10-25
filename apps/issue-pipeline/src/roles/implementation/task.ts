// The Developer session's task: the issue's trusted requirements and what an
// earlier round left for it. The Developer's behaviour is its prompt page
// (task-facts.ts). Pure.

import type { RoleContext } from "../../job/role-context.ts";
import type { Finding } from "../../state.ts";
import type { Mode } from "../change-task.ts";
import { scopeLines } from "../change-task.ts";
import {
  header,
  mergeReturnLines,
  replyLines,
  requirementsLines,
} from "../task-facts.ts";

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
    "An earlier review asked for these changes:",
    "",
    ...findings.map(findingLine),
    "",
  ];
}

// The task of the Developer's session, which does the issue's work.
function workTask(ctx: RoleContext, mode: Mode): string {
  return [
    ...header(ctx, "development"),
    ...scopeLines(ctx, mode),
    ...requirementsLines(ctx),
    ...findingLines(ctx),
    ...mergeReturnLines(ctx.state.mergeReturn),
    ...replyLines([
      "`done`, with a `summary` of the change once it is committed; it becomes the draft PR's description.",
      "`cannot`, with the `reason`.",
    ]),
  ].join("\n");
}

export { workTask };
