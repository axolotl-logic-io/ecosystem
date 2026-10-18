// The implementor's implementer reply: its schema (the wiki's
// Pipeline-Roles-Implementor, "Session reply schemas": `status` and
// `summary` only, `tests-added-derived` and `spec-writer-opens-pr`) and what
// the role reads from a reply. The reader ignores any other field, so a
// reply to today's prompt, with `testsAdded`, `prTitle` and `prBody`, or
// the job's hard-limit handoff, still reads.

import { z } from "zod";
import type { JsonSchema } from "../../workflow/schemas.ts";

type ImplStatus = "done" | "handoff" | "blocked";

// What the role reads from an implementer's reply.
interface ImplReading {
  status: ImplStatus;
  summary: string;
}

const STATUSES: readonly [ImplStatus, ...ImplStatus[]] = [
  "done",
  "handoff",
  "blocked",
];

const IMPL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: STATUSES },
    summary: { type: "string" },
  },
  required: ["status", "summary"],
};

const READING = z.looseObject({
  status: z.enum(STATUSES),
  summary: z.string(),
});

// The reading of `output`, or null when it isn't an implementer's reply.
function implReadingOf(output: unknown): ImplReading | null {
  const parsed = READING.safeParse(output);
  if (!parsed.success) {
    return null;
  }
  const { status, summary } = parsed.data;
  return { status, summary };
}

export type { ImplReading, ImplStatus };
export { IMPL_SCHEMA, implReadingOf };
