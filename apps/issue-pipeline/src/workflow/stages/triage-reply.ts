// The triage agent's reply (TRIAGE_SCHEMA), read from its structured output.
// Checked by hand rather than with zod: this module runs in the pi-subagents
// sandbox, which rejects the async functions any zod bundle contains (#178).

type TriageDecision = "ready" | "needs-info" | "split" | "reject";

interface SubIssue {
  title: string;
  body: string;
  // The 0-based indexes of earlier sub-issues that must merge first.
  after: number[];
}

interface TriageReply {
  decision: TriageDecision;
  reason: string;
  questions: string[];
  subIssues: SubIssue[];
  plan: string;
}

const DECISIONS: readonly TriageDecision[] = [
  "ready",
  "needs-info",
  "split",
  "reject",
];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isSubIssue(value: unknown): value is SubIssue {
  if (!isRecord(value)) {
    return false;
  }
  const { title, body, after } = value;
  return (
    typeof title === "string" &&
    typeof body === "string" &&
    Array.isArray(after) &&
    after.every((index) => typeof index === "number")
  );
}

function isSubIssues(value: unknown): value is SubIssue[] {
  return Array.isArray(value) && value.every(isSubIssue);
}

// The reply, or null when the output doesn't fit the schema. The arrays are
// the output's own, unchanged.
function triageReplyOf(output: unknown): TriageReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { decision, reason, questions, subIssues, plan } = output;
  const known = DECISIONS.find((entry) => entry === decision);
  if (
    known === undefined ||
    typeof reason !== "string" ||
    typeof plan !== "string" ||
    !isStrings(questions) ||
    !isSubIssues(subIssues)
  ) {
    return null;
  }
  return { decision: known, reason, questions, subIssues, plan };
}

export type { TriageReply };
export { triageReplyOf };
