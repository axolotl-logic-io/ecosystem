// The reviewer session's task: one session per round that judges the code
// and the wiki change against the Gherkin, AGENTS.md and the previous round's
// findings, for correctness, tests, acceptance and the four security
// categories (`one-review-session`).

import type { GherkinComment } from "../../gherkin-comment.ts";
import type { RoleContext } from "../../job/role-context.ts";
import type { Finding, Revision } from "../../state.ts";
import { standingRules } from "../prompt-rules.ts";

// What prepare-review wrote for this round.
interface PreparedReview {
  diffPath: string;
  bundlePath: string;
  changedFiles: readonly string[];
}

interface ReviewTaskFacts {
  gherkin: GherkinComment;
  prepared: PreparedReview;
  revision: Revision;
  // The round this review is, counting from 1.
  round: number;
  // Set after the code merged: only the wiki change is under review.
  codeMergedSha: string | null;
}

const SECURITY_LINES = [
  "- `user-harm`: the change would harm the app's users, for example by exposing, leaking or destroying their data.",
  "- `rights`: it would violate users' rights, such as privacy, consent or access to their own data.",
  "- `financial-harm`: it would cause financial harm to users or the operator.",
  "- `abuse-risk`: it would open a risk of abuse, such as missing auth or rate limits, privilege escalation or injection.",
];

function gherkinLines(gherkin: GherkinComment): string[] {
  const lines = [
    `The behaviour to deliver, the issue's Gherkin at revision ${gherkin.rev}:`,
    "",
    "```gherkin",
    gherkin.gherkin,
    "```",
  ];
  if (gherkin.assumptions.length > 0) {
    lines.push("", "The author's assumptions:");
    lines.push(...gherkin.assumptions.map((item) => `- ${item}`));
  }
  if (gherkin.wikiPages.length > 0) {
    lines.push("", "The wiki pages the author said the change should update:");
    lines.push(...gherkin.wikiPages.map((page) => `- ${page}`));
  }
  return lines;
}

function findingLine(finding: Finding): string {
  let where = "";
  if (finding.path !== undefined) {
    let line = "";
    if (finding.line !== undefined) {
      line = `:${finding.line}`;
    }
    where = ` (${finding.path}${line})`;
  }
  return `- #${finding.id} [${finding.severity}]${where} ${finding.text}`;
}

function previousFindings(findings: readonly Finding[]): string[] {
  if (findings.length === 0) {
    return [];
  }
  return [
    "The previous round's findings, which the implementor was asked to resolve. Check each again: report one that is still open as a finding again, in your own words.",
    "",
    ...findings.map(findingLine),
    "",
  ];
}

function scopeLines(facts: ReviewTaskFacts): string[] {
  const { prepared, revision } = facts;
  const lines = [
    `The change under review is in \`${prepared.bundlePath}\` (the diff, then each changed file's text at the head) and \`${prepared.diffPath}\` (the diff alone). It touches: ${prepared.changedFiles.join(", ") || "no files"}.`,
  ];
  if (facts.codeMergedSha === null) {
    lines.push(
      `The code head is \`${revision.code ?? "none: the change lives only in the wiki"}\`, checked out in \`repo/\`.`,
    );
  } else {
    lines.push(
      `The code already merged as \`${facts.codeMergedSha}\`. Only the wiki change below is still unpublished: review it against the merged code in \`repo/\`, which it must describe truly.`,
    );
  }
  if (revision.wiki === null) {
    lines.push("The change has no wiki commits.");
  } else {
    lines.push(
      `The wiki head is \`${revision.wiki}\`, checked out in \`docs/\`.`,
    );
  }
  return lines;
}

function reviewerTask(ctx: RoleContext, facts: ReviewTaskFacts): string {
  const lines = [
    `# Review issue #${ctx.issue} in ${ctx.cfg.repo}, round ${facts.round}`,
    "",
    `Read the issue in \`${ctx.issueFile}\`, \`AGENTS.md\` and the wiki's Decisions pages it points to, then the change.`,
    "",
    ...gherkinLines(facts.gherkin),
    "",
    ...scopeLines(facts),
    "",
    ...previousFindings(ctx.state.review.findings),
    "Judge, in this one session:",
    "- correctness: the change works and breaks nothing it touches;",
    "- the tests: they pin the Gherkin's scenarios and would fail without the change;",
    "- acceptance: the change does what the Gherkin says, no less, and the wiki says what the code now does;",
    "- AGENTS.md and the Decisions pages: the change follows them;",
    "- security, in four categories:",
    ...SECURITY_LINES.map((line) => `  ${line}`),
    "",
    "Report each problem you confirmed as one finding: `blocking` when it must be fixed before merging, `note` otherwise, with its path and line when it has one. Reply `approve` only when no finding is blocking, and `changes` otherwise.",
    "",
    "Set `security` to the category and the reason only when the change would cause that harm; it stops the issue for a person whatever the verdict. Leave it null otherwise.",
    "",
    "You only read: don't edit, commit or run anything.",
    "",
    ...standingRules(ctx.cfg.baseBranch, false),
  ];
  return lines.join("\n");
}

export type { PreparedReview, ReviewTaskFacts };
export { findingLine, reviewerTask };
