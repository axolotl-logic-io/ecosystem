// The structured replies of the writer sessions: each session ends by
// calling its `structured_output` tool with one of these, and the tool
// checks the reply against the schema. A reply grants nothing: the task's
// ops decide every verdict from fresh reads. A task whose session replies
// in another shape, such as Verify's review, keeps that schema with it.

import { z } from "zod";

// The reply of a writer session: Implement's and its hardening's.
const WRITER_REPLY = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("done"), summary: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
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

export { FIX_REPLY, WRITER_REPLY };
