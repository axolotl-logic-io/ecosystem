// The task of Hippy's Sync resolver session: the conflicts the Sync task's
// rebase of revision R onto the exact target T stopped on. It holds facts;
// the behaviour is the `sync` prompt page (task-facts.ts). Pure.

import { JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import { bullets, header, replyLines } from "../task-facts.ts";

function resolverTask(
  ctx: RoleContext,
  conflict: {
    conflicts: readonly string[];
    target: string;
    attempt: number;
    max: number;
    rejected: string | null;
  },
): string {
  const lines = [
    ...header(ctx, "conflict-resolution"),
    ...bullets([
      `The checkout is \`${JOB_REPO}/\``,
      `Rebasing onto the exact target commit \`${conflict.target}\` of \`${ctx.cfg.baseBranch}\``,
      `Attempt: ${conflict.attempt} of ${conflict.max}`,
    ]),
    "",
    "## Conflicting files",
    "",
    ...bullets(conflict.conflicts),
    "",
  ];
  if (conflict.rejected !== null) {
    lines.push(
      "## The last resolution was rejected",
      "",
      conflict.rejected,
      "",
    );
  }
  const resolved =
    "`conflict-resolved`, with a `summary`, once this stop's conflicts are staged. Do not continue the rebase: the Sync task's finish owns continuation, and may return another conflict stop.";
  lines.push(...replyLines([resolved, "`cannot-fix`, with a `summary`."]));
  return lines.join("\n");
}

export { resolverTask };
