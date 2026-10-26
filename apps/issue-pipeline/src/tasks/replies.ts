// The structured replies of the writer sessions: each session ends by
// calling its `structured_output` tool with one of these, and the tool
// checks the reply against the schema. A reply grants nothing: the task's
// ops decide every verdict from fresh reads. A task whose session replies
// in another shape, such as Verify's review, keeps that schema with it.

import { z } from "zod";

// The reply of a writer session: Implement's, its hardening's and Fix's.
const WRITER_REPLY = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("done"), summary: z.string().min(1) }),
  z.strictObject({ outcome: z.literal("cannot"), reason: z.string().min(1) }),
]);

export { WRITER_REPLY };
