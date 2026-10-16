// The JSON schemas of the children's structured replies, for the stages before
// review and the checks: triage, spec, implementation, check fixes and
// acceptance. review-schemas.ts holds the review rounds' schemas.

// The subset of JSON Schema the replies use.
interface JsonSchema {
  type?: string;
  additionalProperties?: boolean;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  items?: JsonSchema;
  maxItems?: number;
  enum?: readonly string[];
}

const STR: JsonSchema = { type: "string" };
const INTEGER: JsonSchema = { type: "integer" };

// A reviewer's finding.
const FINDING: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    severity: { enum: ["blocking", "nit"] },
    file: STR,
    line: INTEGER,
    title: STR,
    evidence: STR,
    suggestion: STR,
  },
  required: ["severity", "file", "line", "title", "evidence", "suggestion"],
};

const SUB_ISSUE: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: STR,
    body: STR,
    after: { type: "array", items: INTEGER },
  },
  required: ["title", "body", "after"],
};

const TRIAGE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { enum: ["ready", "needs-info", "split", "reject"] },
    reason: STR,
    questions: { type: "array", items: STR, maxItems: 5 },
    subIssues: { type: "array", maxItems: 5, items: SUB_ISSUE },
    plan: STR,
  },
  required: ["decision", "reason", "questions", "subIssues", "plan"],
};

const SPEC_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { enum: ["ready", "needs-info"] },
    spec: STR,
    questions: { type: "array", items: STR, maxItems: 5 },
    files: { type: "array", items: STR },
  },
  required: ["decision", "spec", "questions", "files"],
};

const IMPL_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["done", "handoff", "blocked"] },
    summary: STR,
    prTitle: STR,
    prBody: STR,
    testsAdded: { type: "array", items: STR },
  },
  required: ["status", "summary", "prTitle", "prBody", "testsAdded"],
};

const CIFIX_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { enum: ["fixed", "cannot-fix", "handoff"] },
    summary: STR,
  },
  required: ["status", "summary"],
};

const ACCEPT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { verdict: { enum: ["pass", "fail"] }, reason: STR },
  required: ["verdict", "reason"],
};

export type { JsonSchema };
export {
  ACCEPT_SCHEMA,
  CIFIX_SCHEMA,
  FINDING,
  IMPL_SCHEMA,
  INTEGER,
  SPEC_SCHEMA,
  STR,
  TRIAGE_SCHEMA,
};
