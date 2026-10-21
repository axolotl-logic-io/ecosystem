// The merge stage's session tasks: the Reviewer's resolution of a rebase
// its own integration stopped on conflicts, and the read-only security
// review of the merged result. Each holds this run's facts only; the
// behaviour is the phase's wiki page (task-facts.ts). Pure.

import { CODE_RESOLVER_PROTOCOL } from "../../code-resolver-contract.ts";
import { JOB_DOCS, JOB_REPO } from "../../job/layout.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { Revision } from "../../state.ts";
import { bullets, header, replyLines } from "../task-facts.ts";

// Which checkout a stopped rebase is in.
type Side = "code" | "wiki";

// What prepare-review wrote for the security review.
interface PreparedReview {
  diffPath: string;
  bundlePath: string;
  changedFiles: readonly string[];
}

interface SecurityReviewFacts {
  prepared: PreparedReview;
  // The merged result under review: GitHub's merge commit (null for a
  // change that lives only in the wiki) and the wiki head to publish.
  revision: Revision;
}

// Each side's checkout in the job's folder.
const SIDE_DIRS: Readonly<Record<Side, string>> = {
  code: JOB_REPO,
  wiki: JOB_DOCS,
};

function ontoOf(ctx: RoleContext, side: Side): string {
  if (side === "code") {
    return `\`origin/${ctx.cfg.baseBranch}\``;
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
  const lines = [
    ...header(ctx, "conflict-resolution"),
    ...bullets([
      `Side: ${side}; the checkout is \`${dir}/\``,
      `Rebasing onto: ${ontoOf(ctx, side)} at \`${conflict.baseSha}\``,
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
  let resolved =
    "`conflict-resolved`, with a `summary`, once the rebase has finished.";
  if (side === "code") {
    lines.push(`Code resolver protocol: \`${CODE_RESOLVER_PROTOCOL}\``, "");
    resolved =
      "`conflict-resolved`, with a `summary`, once this stop's text conflicts are staged. Stage only the assigned resolved text; do not choose or stage a wiki gitlink. Do not continue the code rebase: finish-sync owns continuation and all wiki gitlink resolutions, and may return another text stop.";
  }
  lines.push(
    ...replyLines([
      resolved,
      "`cannot-fix`, with a `summary`, when the assigned conflicts cannot be resolved.",
    ]),
  );
  return lines.join("\n");
}

function resultLines(facts: SecurityReviewFacts): string[] {
  const { prepared, revision } = facts;
  let code = "Merge commit: none; the change merged no code";
  if (revision.code !== null) {
    code = `Merge commit: \`${revision.code}\`, confirmed by GitHub`;
  }
  let wiki = "Wiki head to publish: none; the change has no wiki commits";
  if (revision.wiki !== null) {
    wiki = `Wiki head to publish: \`${revision.wiki}\`, in \`${JOB_DOCS}/\``;
  }
  return bullets([
    code,
    wiki,
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
    checkout = `detached at the merge commit \`${code}\`: the merged result`;
  }
  return [
    ...header(ctx, "security-review", checkout),
    "## The merged result",
    "",
    ...resultLines(facts),
    "",
    ...replyLines([
      "`summary`: what you examined and what you found.",
      "`security`: null, or the `category` (`user-harm`, `rights`, `financial-harm` or `abuse-risk`) and the `reason`.",
    ]),
  ].join("\n");
}

export type { PreparedReview, SecurityReviewFacts, Side };
export { resolverTask, securityReviewTask };
