import { z } from "zod";

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

export { FIX_REPLY };
