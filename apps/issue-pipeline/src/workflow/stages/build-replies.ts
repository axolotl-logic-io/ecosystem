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

const SPEC_DECISIONS: readonly SpecDecision[] = ["ready", "needs-info"];
const IMPL_STATUSES: readonly ImplStatus[] = ["done", "handoff", "blocked"];

// The spec writer's reply, or null when the output doesn't fit the schema.
function specReplyOf(output: unknown): SpecReply | null {
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
  return { decision: known, spec, questions, files };
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

export type { ImplReply, SpecReply };
export { implReplyOf, specReplyOf };
