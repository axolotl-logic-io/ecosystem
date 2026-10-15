// The blocking findings an issue carries through its fix rounds: numbering and
// storing them, which are still open, how comments and prompts list them, and
// how open ones name the issue's stop.

import { clip } from "./clip.ts";
import type {
  Finding,
  FixRoundsConfig,
  IssueState,
  ListedFinding,
  ReportedFinding,
} from "./types.ts";

// How much of each reported field the saved state keeps.
const FILE_LIMIT = 200;
const TITLE_LIMIT = 200;
const EVIDENCE_LIMIT = 600;
const SUGGESTION_LIMIT = 400;

// Whether a finding names a security harm category.
function hasCategory(finding: Pick<Finding, "category">): boolean {
  return typeof finding.category === "string" && finding.category !== "";
}

function categoryOf(reported: ReportedFinding): string | null {
  const { category } = reported;
  if (typeof category === "string" && category !== "") {
    return category;
  }
  return null;
}

// The stop that open findings give: the reason, the findings, and the stop
// code that names the harm, or null for the generic one.
interface FindingsStop {
  reason: string;
  detail: string;
  code: string | null;
}

interface FindingsItem {
  st: Pick<IssueState, "findings" | "nextFindingId">;
}

// Numbers a reported finding (f1, f2, …), stores it open in the item's state,
// and returns the stored finding.
function addFinding(
  item: FindingsItem,
  reported: ReportedFinding,
  lenses: string[],
): Finding {
  const number = (item.st.nextFindingId ?? 0) + 1;
  item.st.nextFindingId = number;
  const finding: Finding = {
    id: `f${number}`,
    file: clip(reported.file, FILE_LIMIT),
    line: reported.line,
    title: clip(reported.title, TITLE_LIMIT),
    evidence: clip(reported.evidence, EVIDENCE_LIMIT),
    suggestion: clip(reported.suggestion, SUGGESTION_LIMIT),
    lenses,
    category: categoryOf(reported),
    status: "open",
    disputed: false,
  };
  item.st.findings.push(finding);
  return finding;
}

function openFindings(item: FindingsItem): Finding[] {
  return item.st.findings.filter((finding) => finding.status === "open");
}

function openSecurityFinding(item: FindingsItem): Finding | undefined {
  return openFindings(item).find(hasCategory);
}

// The stop code for open findings: a security category if any security finding
// is still open, so the label names the harm; otherwise null, the generic
// review-rounds code.
function findingsStopCode(item: FindingsItem): string | null {
  return openSecurityFinding(item)?.category ?? null;
}

// The stop reason for open findings: an open security finding's, or `base`.
function findingsStopReason(
  cfg: FixRoundsConfig,
  item: FindingsItem,
  base: string,
): string {
  const security = openSecurityFinding(item);
  if (security === undefined) {
    return base;
  }
  return `security review (${security.category}): ${security.title} is still open after ${cfg.maxFixRounds} fix rounds`;
}

// The stop for open findings: their reason with `base` as the fallback, the
// findings as text, and the security category as the stop code, or null.
function findingsStop(
  cfg: FixRoundsConfig,
  item: FindingsItem,
  base: string,
): FindingsStop {
  return {
    reason: findingsStopReason(cfg, item, base),
    detail: findingsText(openFindings(item)),
    code: findingsStopCode(item),
  };
}

function listedId(finding: ListedFinding): string {
  if (typeof finding.id === "string" && finding.id !== "") {
    return `**${finding.id}** `;
  }
  return "";
}

// Findings as a review comment lists them, one Markdown item each.
function findingLines(list: readonly ListedFinding[]): string {
  return list
    .map(
      (f) =>
        `- ${listedId(f)}\`${f.file}:${f.line}\` ${f.title}\n  ${f.evidence}\n  Suggested: ${f.suggestion}`,
    )
    .join("\n");
}

function securityNote(finding: Finding): string {
  if (hasCategory(finding)) {
    return ` (security: ${finding.category})`;
  }
  return "";
}

function disputeNote(finding: Finding): string {
  if (typeof finding.dispute === "string" && finding.dispute !== "") {
    return `\n  Fixer's dispute: ${finding.dispute}`;
  }
  return "";
}

// Numbered findings as a fixer's or re-reviewer's prompt lists them.
function findingsText(list: readonly Finding[]): string {
  return list
    .map(
      (f) =>
        `- ${f.id}${securityNote(f)} [${f.file}:${f.line}] ${f.title}\n  Evidence: ${f.evidence}\n  Suggestion: ${f.suggestion}${disputeNote(f)}`,
    )
    .join("\n");
}

export type { FindingsStop };
export {
  addFinding,
  findingLines,
  findingsStop,
  findingsStopCode,
  findingsStopReason,
  findingsText,
  openFindings,
};
