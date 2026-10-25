// Exact Security decision schemas shared by saved-state receipts.
import { z } from "zod";
import { REVISION } from "./land-provenance.ts";
import { REVIEWED_TARGET } from "./reviewed-target.ts";

// The categories a security review stops an issue for (stops.ts codes).
const SECURITY_CATEGORY = z.enum([
  "user-harm",
  "rights",
  "financial-harm",
  "abuse-risk",
]);

// Candidate phase and target validate together. Phase-absent receipts remain
// historical post-Land observations, never permission for a new Land.
const SECURITY_VERDICT = z.object({
  revision: REVISION,
  commentId: z.number().int().positive(),
  finding: z
    .object({ category: SECURITY_CATEGORY, reason: z.string().min(1) })
    .nullable(),
});
const SECURITY = z.union([
  SECURITY_VERDICT.extend({
    phase: z.literal("candidate"),
    target: REVIEWED_TARGET,
  }),
  SECURITY_VERDICT.extend({
    phase: z.undefined().optional(),
    target: z.undefined().optional(),
  }),
]);

export { SECURITY, SECURITY_CATEGORY, SECURITY_VERDICT };
