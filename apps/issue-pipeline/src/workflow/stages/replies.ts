// The final reviewers' replies (ACCEPT_SCHEMA and SECURITY_SCHEMA), read from
// their structured output. Checked by hand rather than with zod: these modules
// run in the pi-subagents sandbox, which rejects the async functions any zod
// bundle contains (#178).

import type { ReportedFinding } from "../types.ts";
import { isRecord } from "./reply-guards.ts";

type Verdict = "pass" | "fail";

interface AcceptReply {
  verdict: Verdict;
  reason: string;
}

interface SecurityReply {
  findings: ReportedFinding[];
}

const VERDICTS: readonly Verdict[] = ["pass", "fail"];

// The value if it is text, else null.
function textOrNull(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  return null;
}

function isCategory(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isReportedFinding(value: unknown): value is ReportedFinding {
  if (!isRecord(value)) {
    return false;
  }
  const { file, line, title, evidence, suggestion, category } = value;
  return (
    typeof file === "string" &&
    typeof line === "number" &&
    typeof title === "string" &&
    typeof evidence === "string" &&
    typeof suggestion === "string" &&
    isCategory(category)
  );
}

// The acceptance verifier's verdict, or null when the output doesn't fit the
// schema.
function acceptReplyOf(output: unknown): AcceptReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { verdict, reason } = output;
  const known = VERDICTS.find((entry) => entry === verdict);
  if (known === undefined || typeof reason !== "string") {
    return null;
  }
  return { verdict: known, reason };
}

// The security reviewer's findings, or null when the output doesn't fit the
// schema. The findings are the output's own, unchanged.
function securityReplyOf(output: unknown): SecurityReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { findings } = output;
  if (!(Array.isArray(findings) && findings.every(isReportedFinding))) {
    return null;
  }
  return { findings };
}

export type { AcceptReply, SecurityReply };
export { acceptReplyOf, securityReplyOf, textOrNull };
