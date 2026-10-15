// The JSON schemas of the review rounds' structured replies: the first
// reviewers, the aggregator, the fixer, the re-reviewers and the security
// reviewer.

import { HARM_CATEGORIES } from "./lenses.ts";
import type { JsonSchema } from "./schemas.ts";
import { FINDING, INTEGER, STR } from "./schemas.ts";

type Properties = Readonly<Record<string, JsonSchema>>;

// An object with exactly these properties, all required, in their order.
function closedObject(properties: Properties): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: Object.keys(properties),
  };
}

// A finding's location and text, as later rounds report it.
const LOCATED: Properties = {
  file: STR,
  line: INTEGER,
  title: STR,
  evidence: STR,
  suggestion: STR,
};

const HARM: JsonSchema = { enum: HARM_CATEGORIES };

const SECURITY_SCHEMA: JsonSchema = closedObject({
  findings: {
    type: "array",
    maxItems: 10,
    items: closedObject({ ...LOCATED, category: HARM }),
  },
});

const REVIEW_SCHEMA: JsonSchema = closedObject({
  findings: { type: "array", items: FINDING, maxItems: 15 },
});

const AGG_SCHEMA: JsonSchema = closedObject({
  blocking: {
    type: "array",
    items: closedObject({
      ...LOCATED,
      lenses: {
        type: "array",
        items: { enum: ["correctness", "tests", "scope"] },
      },
    }),
  },
});

const FIX_SCHEMA: JsonSchema = closedObject({
  fixed: { type: "array", items: STR },
  disputed: { type: "array", items: closedObject({ id: STR, evidence: STR }) },
  summary: STR,
});

const REREVIEW_STATUS: JsonSchema = {
  enum: ["resolved", "unresolved", "dispute-accepted", "dispute-rejected"],
};

// A re-reviewer's reply: a verdict on each open finding, and the new findings
// the fix introduced, each with `newFinding`'s extra properties.
function rereviewSchema(newFinding: Properties): JsonSchema {
  return closedObject({
    results: {
      type: "array",
      items: closedObject({ id: STR, status: REREVIEW_STATUS, note: STR }),
    },
    newFindings: {
      type: "array",
      maxItems: 10,
      items: closedObject({ ...LOCATED, recursId: STR, ...newFinding }),
    },
  });
}

const REREVIEW_SCHEMA: JsonSchema = rereviewSchema({});
// The security re-reviewer's new findings carry a harm category too.
const REREVIEW_SEC_SCHEMA: JsonSchema = rereviewSchema({ category: HARM });

export {
  AGG_SCHEMA,
  FIX_SCHEMA,
  REREVIEW_SCHEMA,
  REREVIEW_SEC_SCHEMA,
  REVIEW_SCHEMA,
  SECURITY_SCHEMA,
};
