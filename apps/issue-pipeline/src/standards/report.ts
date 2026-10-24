// The readable sides of a standards assessment: report.md for people, and
// plan.md, the body an allow-listed person files as the repository's one
// upgrade issue. The plan's marker binds it to the assessed repository,
// commit, policy and assessment digest; `standards-upgrade apply` and the
// existing issue-delivery chain take it from there (#129).

import { digestOf } from "./assess.ts";
import type { Assessment, PlanMarker } from "./schema.ts";

const PLAN_TAG = "standards-upgrade:plan";
const SHORT_SHA = 12;

const STATUS_WORDS: Readonly<Record<string, string>> = {
  passed: "verified pass",
  failed: "evidenced failure",
  unverified: "unverified",
  "not-applicable": "not applicable",
};

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function criteriaTable(assessment: Assessment): string[] {
  if (assessment.criteria.length === 0) {
    return ["No criteria apply to this disposition."];
  }
  return [
    "| Criterion | Status | Evidence |",
    "|---|---|---|",
    ...assessment.criteria.map(
      ({ id, status, evidence }) =>
        `| \`${id}\` | ${STATUS_WORDS[status] ?? status} | ${cell(evidence)} |`,
    ),
  ];
}

function bullets(items: readonly string[], none: string): string[] {
  if (items.length === 0) {
    return [none];
  }
  return items.map((item) => `- ${item}`);
}

function header(assessment: Assessment): string[] {
  const {
    repo,
    source,
    sourceRef,
    policy,
    assessedAt,
    toolchain,
    disposition,
  } = assessment;
  return [
    `- Repository: \`${repo}\`, \`${sourceRef}\` at \`${source}\``,
    `- Policy: \`${policy}\`; assessed ${assessedAt} with Node ${toolchain.node}, ${toolchain.git}`,
    `- Disposition: **${disposition.kind}**: ${disposition.detail}`,
    `- Verdict: **${assessment.verdict}**`,
  ];
}

function reportOf(assessment: Assessment): string {
  const components = assessment.inventory.components.map(
    (component) =>
      `\`${component.path}\` (${component.name ?? "unnamed"}; lockfile ${component.lockfile ?? "none"})`,
  );
  const workflows = assessment.inventory.workflows.map(
    (workflow) =>
      `\`${workflow.path}\`: ${workflow.triggers.join(", ") || "no triggers"}`,
  );
  return [
    `# Standards assessment of ${assessment.repo}`,
    "",
    ...header(assessment),
    "",
    "This assessment ran no repository code. Install, test and advisory criteria stay unverified until a later run executes them.",
    "",
    "## Criteria",
    "",
    ...criteriaTable(assessment),
    "",
    "## Inventory",
    "",
    ...bullets(components, "No package components."),
    ...bullets(workflows, "No workflows."),
    "",
    "## Proposed changes",
    "",
    ...bullets(
      assessment.proposed.map(
        ({ criterion, change }) => `\`${criterion}\`: ${change}`,
      ),
      "None.",
    ),
    "",
    "## Owner actions",
    "",
    ...bullets(assessment.ownerActions, "None."),
    "",
  ].join("\n");
}

const RULES = [
  "Make the smallest change that closes each gap. Keep every existing feature, test and piece of content.",
  "Before fixing a defect, add a regression test that fails on it.",
  "Run npm ci, npm test and npm audit on the result and report their exit codes. Report a check you can't run as unverified, never as passed.",
  "Don't change repository settings, branch protection, rulesets, deployment, domains or the license. The owner actions below need separate authority.",
  "Ask when the intended behavior is unclear, instead of inventing a feature.",
];

// The upgrade issue body for a Node/npm assessment with gaps, or null when
// there's nothing for an upgrade to change.
function planOf(assessment: Assessment): string | null {
  if (
    assessment.disposition.kind !== "node-npm" ||
    assessment.proposed.length === 0
  ) {
    return null;
  }
  const marker: PlanMarker = {
    version: 1,
    repo: assessment.repo,
    source: assessment.source,
    policy: assessment.policy,
    digest: digestOf(assessment),
  };
  return [
    `<!-- ${PLAN_TAG} ${JSON.stringify(marker)} -->`,
    `# Standards upgrade of ${assessment.repo} from ${assessment.source.slice(0, SHORT_SHA)}`,
    "",
    ...header(assessment),
    "",
    "## Changes to make",
    "",
    ...assessment.proposed.map(
      ({ criterion, change }) => `- [ ] \`${criterion}\`: ${change}`,
    ),
    "",
    "## Rules",
    "",
    ...RULES.map((rule) => `- ${rule}`),
    "",
    "## Findings",
    "",
    ...criteriaTable(assessment),
    "",
    "## Owner actions (not part of this change)",
    "",
    ...bullets(assessment.ownerActions, "None."),
    "",
  ].join("\n");
}

export { PLAN_TAG, planOf, reportOf };
