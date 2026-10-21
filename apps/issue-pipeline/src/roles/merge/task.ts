// The merge stage's session tasks: the Reviewer's resolution of a rebase
// its own integration stopped on conflicts, and the read-only security
// review of the merged result. Each holds this run's facts only; the
// behaviour is the phase's prompt page (task-facts.ts). Pure.

import { JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { CodeMerged, Revision } from "../../state.ts";
import { bullets, header, replyLines } from "../task-facts.ts";

// What prepare-review wrote for the security review.
interface PreparedReview {
  diffPath: string;
  bundlePath: string;
  changedFiles: readonly string[];
}

interface SecurityReviewFacts {
  prepared: PreparedReview;
  // The merged result under review: GitHub's merge commit, or null when
  // the change merged no code.
  revision: Revision;
  codeMerged: CodeMerged | null;
}

// The task of a session that resolves the code rebase stopped on
// conflicts.
function resolverTask(
  ctx: RoleContext,
  conflict: {
    conflicts: readonly string[];
    baseSha: string;
    attempt: number;
    max: number;
    rejected: string | null;
  },
): string {
  const lines = [
    ...header(ctx, "conflict-resolution"),
    ...bullets([
      `The checkout is \`${JOB_REPO}/\``,
      `Rebasing onto: \`origin/${ctx.cfg.baseBranch}\` at \`${conflict.baseSha}\``,
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
    "`conflict-resolved`, with a `summary`, once this stop's text conflicts are staged. Do not continue the rebase: finish-sync owns continuation, and may return another text stop.";
  lines.push(...replyLines([resolved, "`cannot-fix`, with a `summary`."]));
  return lines.join("\n");
}

function resultLines(facts: SecurityReviewFacts): string[] {
  const { prepared, revision } = facts;
  let code = "Merge commit: none; the change merged no code";
  if (revision.code !== null) {
    code = `Reviewed commit: \`${revision.code}\``;
  }
  return bullets([
    code,
    `Bundle: \`${prepared.bundlePath}\``,
    `Diff: \`${prepared.diffPath}\``,
    `Changed files: ${prepared.changedFiles.join(", ") || "none"}`,
  ]);
}

// The task of the security review of the merged result.
function securityReviewTask(
  ctx: RoleContext,
  facts: SecurityReviewFacts,
): string {
  const { code } = facts.revision;
  let checkout = "on the issue's branch";
  if (code !== null) {
    checkout = `at exactly the reviewed commit \`${code}\``;
  }
  return [
    ...header(ctx, "security-review", checkout),
    "## The reviewed revision",
    "",
    ...resultLines(facts),
    "",
    ...replyLines([
      "`summary`: what you examined and what you found.",
      "`security`: null, or the `category` (`user-harm`, `rights`, `financial-harm` or `abuse-risk`) and the `reason`.",
    ]),
  ].join("\n");
}

export type { PreparedReview, SecurityReviewFacts };
export { resolverTask, securityReviewTask };
