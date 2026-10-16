// The triage agent's reply (TRIAGE_SCHEMA), read from its structured output.
// Checked by hand rather than with zod: this module runs in the pi-subagents
// sandbox, which rejects the async functions any zod bundle contains (#178).

import { isRecord, isStrings } from "./reply-guards.ts";

type TriageDecision = "ready" | "needs-info" | "split" | "reject";

interface TriageReply {
  decision: TriageDecision;
  reason: string;
  questions: string[];
  plan: string;
}

const DECISIONS: readonly TriageDecision[] = [
  "ready",
  "needs-info",
  "split",
  "reject",
];

// The reply, or null when the output doesn't fit the schema. Its questions
// are the output's own, unchanged.
function triageReplyOf(output: unknown): TriageReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { decision, reason, questions, plan } = output;
  const known = DECISIONS.find((entry) => entry === decision);
  if (
    known === undefined ||
    typeof reason !== "string" ||
    typeof plan !== "string" ||
    !isStrings(questions)
  ) {
    return null;
  }
  return { decision: known, reason, questions, plan };
}

export type { TriageReply };
export { triageReplyOf };
