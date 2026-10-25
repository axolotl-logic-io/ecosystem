// The structured replies of the task sessions: each session ends by calling
// its `structured_output` tool with one of these, and the tool checks the
// reply against the schema. A reply grants nothing: the task's ops decide
// every verdict from fresh reads.

import { z } from "zod";

const SECURITY_CATEGORY = z.enum([
  "user-harm",
  "rights",
  "financial-harm",
  "abuse-risk",
]);

// The reply of a writer session: Implement's, Harden's and Sync's resolver.
const WRITER_REPLY = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("done"), summary: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
]);

// Review Security's one read-only session: a null `finding` passes; a
// category refuses the reviewed subject.
const SECURITY_REVIEW_REPLY = z.strictObject({
  summary: z.string().min(1),
  finding: z
    .strictObject({ category: SECURITY_CATEGORY, reason: z.string().min(1) })
    .nullable(),
});

type WriterReply = z.infer<typeof WRITER_REPLY>;
type SecurityReviewReply = z.infer<typeof SECURITY_REVIEW_REPLY>;

export type { SecurityReviewReply, WriterReply };
export { SECURITY_REVIEW_REPLY, WRITER_REPLY };
