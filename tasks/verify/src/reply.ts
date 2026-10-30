import { z } from "zod";

const MAX_FINDING = 4000;

// One finding of the review session. One with a `path` and a `line` is
// about those lines; any other is about the change as a whole. A nit
// changes no behavior, safety or maintainability; a Security finding
// blocks whatever its severity.
const FINDING = z.strictObject({
  path: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  body: z.string().min(1).max(MAX_FINDING),
  severity: z.enum(["blocking", "nit"]),
  security: z.boolean(),
});

// The reply of Verify's one read-only session: what it examined, and every
// finding. The reply grants nothing: the effect op decides the review from
// it, the checks and the required CI.
const VERIFY_REPLY = z.strictObject({
  summary: z.string().min(1).max(MAX_FINDING),
  findings: z.array(FINDING),
});

type VerifyFinding = z.infer<typeof FINDING>;
type VerifyReply = z.infer<typeof VERIFY_REPLY>;

export type { VerifyFinding, VerifyReply };
export { VERIFY_REPLY };
