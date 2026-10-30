// The readable sides of a standards assessment: report.md for people, and
// plan.md, the body an allow-listed person files as the repository's one
// upgrade issue. The plan's marker binds it to the assessed repository,
// commit, policy and assessment digest; `standards-upgrade apply` and the
// existing issue-delivery chain take it from there (#129).

import { digestOf } from "./assess.ts";
import type { Assessment, PlanMarker } from "./schema.ts";
import { PLAN_TAG } from "./schema.ts";

const SHORT_SHA = 12;
const NETWORK_WORDS: Readonly<Record<string, string>> = {
  true: "network",
  false: "no network",
};

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

function runNote(assessment: Assessment): string {
  const { sandbox, commands } = assessment;
  if (commands.length > 0) {
    return `Install, tests and the advisory scan ran in a credential-free ${sandbox?.tool ?? "bwrap"} sandbox. What they printed is in logs/ beside this report, never here: repository code wrote it.`;
  }
  return "This assessment ran no repository code. Install, test and advisory criteria say why they're unverified.";
}

function commandLines(assessment: Assessment): string[] {
  return assessment.commands.map(
    ({ argv, network, exitCode, durationMs, log }) =>
      `\`${argv.join(" ")}\` (${NETWORK_WORDS[String(network)]}): exit ${exitCode ?? "none, timed out"}, ${durationMs} ms, \`${log}\``,
  );
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
    runNote(assessment),
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
    "## Commands run in the sandbox",
    "",
    ...bullets(commandLines(assessment), "None."),
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

// The checks each supported ecosystem's upgrade runs on its result.
const CHECKS: Readonly<Record<string, string>> = {
  "node-npm": "npm ci, npm test and npm audit",
  "python-poetry":
    "poetry check --lock, poetry install, poetry run pytest and pip-audit",
};

function rulesOf(checks: string): string[] {
  return [
    "Make the smallest change that closes each gap. Keep every existing feature, test and piece of content.",
    "Before fixing a defect, add a regression test that fails on it.",
    `Run ${checks} on the result and report their exit codes. Report a check you can't run as unverified, never as passed.`,
    "Don't change repository settings, branch protection, rulesets, deployment, domains or the license. The owner actions below need separate authority.",
    "Ask when the intended behavior is unclear, instead of inventing a feature.",
  ];
}

// The upgrade issue body for a Node/npm or Python/Poetry assessment with
// gaps, or null when there's nothing for an upgrade to change.
function planOf(assessment: Assessment): string | null {
  const checks = CHECKS[assessment.disposition.kind];
  if (checks === undefined || assessment.proposed.length === 0) {
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
    ...rulesOf(checks).map((rule) => `- ${rule}`),
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

export { planOf, reportOf };
