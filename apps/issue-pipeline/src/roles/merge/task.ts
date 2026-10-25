// The merge stage's one session task: the read-only security review of the
// candidate or historical landed result. It holds facts; the behaviour is
// the phase's prompt page (task-facts.ts). Pure.

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
  // The exact candidate or historical confirmed landed revision.
  revision: Revision;
  codeMerged: CodeMerged | null;
}

function resultLines(facts: SecurityReviewFacts): string[] {
  const { prepared, revision, codeMerged } = facts;
  let code = "Merge commit: none; the change merged no code";
  if (revision.code !== null) {
    code = `Candidate commit: \`${revision.code}\``;
    if (codeMerged !== null) {
      code = `Historical merged commit: \`${revision.code}\``;
    }
  }
  return bullets([
    code,
    `Bundle: \`${prepared.bundlePath}\``,
    `Diff: \`${prepared.diffPath}\``,
    `Changed files: ${prepared.changedFiles.join(", ") || "none"}`,
  ]);
}

// Facts for a candidate Security review or historical landed recovery.
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
export { securityReviewTask };
