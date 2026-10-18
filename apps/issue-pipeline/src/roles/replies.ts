// The structured replies of the three model roles: each session ends by
// calling its `structured_output` tool with one of these, and the tool checks
// the reply against the schema. That check is the only reply validation
// (`one-review-session`): no reply-check framework sits behind it.

import { z } from "zod";

const FEATURE = /^\s*Feature:/mu;
const SCENARIO = /^\s*Scenario/mu;
const MAX_QUESTIONS = 5;

const AUTHOR_REPLY = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("gherkin"),
    gherkin: z
      .string()
      .refine(
        (text) => FEATURE.test(text) && SCENARIO.test(text),
        "the Gherkin must have a Feature: line and at least one Scenario",
      ),
    assumptions: z.array(z.string().min(1)),
    wikiPages: z.array(z.string().min(1)),
    // Whether the behaviour differs from the Gherkin comment the task showed.
    changed: z.boolean(),
  }),
  z.object({
    outcome: z.literal("needs-info"),
    questions: z.array(z.string().min(1)).min(1).max(MAX_QUESTIONS),
  }),
]);

const IMPLEMENTOR_REPLY = z.discriminatedUnion("outcome", [
  // The job verifies the work; "done" is never taken as "checks pass".
  z.object({ outcome: z.literal("done"), summary: z.string().min(1) }),
  z.object({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
  // Resolver mode only: the task asked it to finish a stopped rebase.
  z.object({
    outcome: z.enum(["conflict-resolved", "cannot-fix"]),
    summary: z.string().min(1),
  }),
]);

const SECURITY_CATEGORY = z.enum([
  "user-harm",
  "rights",
  "financial-harm",
  "abuse-risk",
]);

// A finding as the reviewer reports it; the job numbers it (state.ts FINDING).
const REVIEW_FINDING = z.object({
  severity: z.enum(["blocking", "note"]),
  text: z.string().min(1),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
});

// A non-null `security` stops the issue with that category's stop label,
// whatever the verdict says.
const REVIEWER_REPLY = z.object({
  verdict: z.enum(["approve", "changes"]),
  summary: z.string().min(1),
  findings: z.array(REVIEW_FINDING),
  security: z
    .object({ category: SECURITY_CATEGORY, reason: z.string().min(1) })
    .nullable(),
});

type AuthorReply = z.infer<typeof AUTHOR_REPLY>;
type ImplementorReply = z.infer<typeof IMPLEMENTOR_REPLY>;
type ReviewerReply = z.infer<typeof REVIEWER_REPLY>;
type SecurityCategory = z.infer<typeof SECURITY_CATEGORY>;

export type { AuthorReply, ImplementorReply, ReviewerReply, SecurityCategory };
export { AUTHOR_REPLY, IMPLEMENTOR_REPLY, REVIEW_FINDING, REVIEWER_REPLY };
