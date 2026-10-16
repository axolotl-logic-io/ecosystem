// The spec writer's reply (SPEC_SCHEMA) and the implementer's (IMPL_SCHEMA),
// read from their structured output. Checked by hand rather than with zod:
// this module runs in the pi-subagents sandbox, which rejects the async
// functions any zod bundle contains (#178).

import { isRecord, isStrings } from "./reply-guards.ts";

type SpecDecision = "ready" | "needs-info";

interface SpecReply {
  decision: SpecDecision;
  spec: string;
  questions: string[];
  // The repo paths or globs the change will touch.
  files: string[];
}

type ImplStatus = "done" | "handoff" | "blocked";

interface ImplReply {
  status: ImplStatus;
  summary: string;
  prTitle: string;
  prBody: string;
  testsAdded: string[];
}

// A spec writer's reply that fits the schema: complete when its spec ends with
// SPEC_END, which is then stripped, or cut short when it doesn't (#280).
type SpecRead = { complete: true; reply: SpecReply } | { complete: false };

// The line the spec writer writes last in `spec`, after every section, so a
// spec that stops partway can be told from a whole one (#280). An HTML comment,
// so it would not show even if it were posted.
const SPEC_END = "<!-- end of spec -->";

const SPEC_DECISIONS: readonly SpecDecision[] = ["ready", "needs-info"];
const IMPL_STATUSES: readonly ImplStatus[] = ["done", "handoff", "blocked"];

// The spec writer's reply, or null when the output doesn't fit the schema.
function specReplyOf(output: unknown): SpecRead | null {
  if (!isRecord(output)) {
    return null;
  }
  const { decision, spec, questions, files } = output;
  const known = SPEC_DECISIONS.find((entry) => entry === decision);
  if (
    known === undefined ||
    typeof spec !== "string" ||
    !isStrings(questions) ||
    !isStrings(files)
  ) {
    return null;
  }
  const text = spec.trimEnd();
  if (!text.endsWith(SPEC_END)) {
    return { complete: false };
  }
  const whole = text.slice(0, -SPEC_END.length).trimEnd();
  return {
    complete: true,
    reply: { decision: known, spec: whole, questions, files },
  };
}

// The implementer's reply, or null when the output doesn't fit the schema.
function implReplyOf(output: unknown): ImplReply | null {
  if (!isRecord(output)) {
    return null;
  }
  const { status, summary, prTitle, prBody, testsAdded } = output;
  const known = IMPL_STATUSES.find((entry) => entry === status);
  if (
    known === undefined ||
    typeof summary !== "string" ||
    typeof prTitle !== "string" ||
    typeof prBody !== "string" ||
    !isStrings(testsAdded)
  ) {
    return null;
  }
  return { status: known, summary, prTitle, prBody, testsAdded };
}

export type { ImplReply, SpecRead, SpecReply };
export { implReplyOf, SPEC_END, specReplyOf };
