// The triage agent's reply (TRIAGE_SCHEMA), read from its structured output,
// and what the pipeline does with it. Checked by hand rather than with zod:
// this module is bundled into workflow.js, which runs in the pi-subagents
// sandbox, and that sandbox rejects the async functions any zod bundle
// contains (#178).

import { isRecord, isStrings } from "../../workflow/stages/reply-guards.ts";

type TriageDecision = "ready" | "needs-info" | "split" | "reject";

interface TriageReply {
  decision: TriageDecision;
  reason: string;
  questions: string[];
  plan: string;
}

// The draft PR the start-pr op opened, or found already open.
interface StartedPr {
  pr: number;
  headSha: string;
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

// What the pipeline does with `reply` on an issue at `depth` (0 for an
// issue, 1 for a sub-issue). A sub-issue's split, or questions with none
// asked, read as a reject.
function decisionOf(reply: TriageReply, depth: number): TriageDecision {
  const { decision } = reply;
  switch (decision) {
    case "split":
      if (depth >= 1) {
        return "reject";
      }
      return decision;
    case "needs-info":
      if (reply.questions.length === 0) {
        return "reject";
      }
      return decision;
    case "ready":
    case "reject":
      return decision;
    default: {
      const unhandled: never = decision;
      return unhandled;
    }
  }
}

// The PR a start-pr reply names, or null when the op didn't open one.
function startedPrOf(reply: unknown): StartedPr | null {
  if (!isRecord(reply)) {
    return null;
  }
  const { ok, pr, headSha } = reply;
  if (ok !== true || typeof pr !== "number" || typeof headSha !== "string") {
    return null;
  }
  return { pr, headSha };
}

export type { StartedPr, TriageDecision, TriageReply };
export { decisionOf, startedPrOf, triageReplyOf };
