// The structured replies of the three model roles: each session ends by
// calling its `structured_output` tool with one of these, and the tool checks
// the reply against the schema. That check is the only reply validation
// (`one-review-session`): no reply-check framework sits behind it.

import { z } from "zod";
import { SECURITY_CATEGORY } from "../state-security.ts";

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
    // Whether the behaviour differs from the Gherkin comment the task showed.
    changed: z.boolean(),
  }),
  z.object({
    outcome: z.literal("needs-info"),
    questions: z.array(z.string().min(1)).min(1).max(MAX_QUESTIONS),
  }),
]);

// The reply of every session that writes: the Developer's, and the
// Reviewer's while it hardens or integrates a change.
const WRITER_REPLY = z.discriminatedUnion("outcome", [
  // The job verifies the work; "done" is never taken as "checks pass".
  z.object({ outcome: z.literal("done"), summary: z.string().min(1) }),
  z.object({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
  // A resolver task only: it asked the session to finish a stopped rebase.
  z.object({
    outcome: z.enum(["conflict-resolved", "cannot-fix"]),
    summary: z.string().min(1),
  }),
]);

// The Reviewer's final review, its one read-only session after hardening,
// which judges security alone: hardening owns the design, the correctness
// and the tests. A null `security` approves; a category stops the issue
// with that category's stop label.
const SECURITY_REVIEW_REPLY = z.object({
  summary: z.string().min(1),
  security: z
    .object({ category: SECURITY_CATEGORY, reason: z.string().min(1) })
    .nullable(),
});

type AuthorReply = z.infer<typeof AUTHOR_REPLY>;
type WriterReply = z.infer<typeof WRITER_REPLY>;
type SecurityReviewReply = z.infer<typeof SECURITY_REVIEW_REPLY>;

export type { AuthorReply, SecurityReviewReply, WriterReply };
export { AUTHOR_REPLY, SECURITY_REVIEW_REPLY, WRITER_REPLY };
