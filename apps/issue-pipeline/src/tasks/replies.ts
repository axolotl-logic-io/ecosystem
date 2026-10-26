// The structured replies of the writer sessions: each session ends by
// calling its `structured_output` tool with one of these, and the tool
// checks the reply against the schema. A reply grants nothing: the task's
// ops decide every verdict from fresh reads. A task whose session replies
// in another shape, such as Verify's review, keeps that schema with it.

import { z } from "zod";

// Most questions an Author may ask instead of writing Gherkin.
const AUTHOR_QUESTIONS = 5;

// The reply of a writer session: Implement's and its hardening's.
const WRITER_REPLY = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("done"), summary: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
]);

// Author's reply: the issue's behaviour as Gherkin, with the calls the
// Author made and whether the behaviour differs from the Gherkin the issue
// had; or the questions only the issue's author can answer.
const AUTHOR_REPLY = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("gherkin"),
    gherkin: z.string().min(1),
    assumptions: z.array(z.string().min(1)),
    changed: z.boolean(),
  }),
  z.strictObject({
    outcome: z.literal("needs-info"),
    questions: z.array(z.string().min(1)).min(1).max(AUTHOR_QUESTIONS),
  }),
]);

// Fix's reply: what it changed, and its answer to each blocking review
// comment its task listed, by the comment's id, which the pipeline posts in
// that comment's thread.
const FIX_REPLY = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("done"),
    summary: z.string().min(1),
    replies: z.array(
      z.strictObject({
        comment: z.number().int().positive(),
        reply: z.string().min(1),
      }),
    ),
  }),
  z.strictObject({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
]);

export { AUTHOR_REPLY, FIX_REPLY, WRITER_REPLY };
