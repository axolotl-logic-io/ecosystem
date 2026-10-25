// Immutable authorization and attempted-Land evidence shared by state and recovery.
import { z } from "zod";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const FULL_SHA = z.string().regex(FULL_SHA_PATTERN);

// What a review or a Land saw: the code head and the trusted-inputs
// revision. `wiki` is legacy: a revision saved while the pipeline had a wiki
// names its wiki head (null with no wiki commits). The pipeline writes none,
// and an absent one reads as null (legacyWikiOf).
const REVISION = z.object({
  code: z.string().nullable(),
  wiki: z.string().nullable().optional(),
  inputs: z.string(),
  // Missing only on historical receipts; never synthesize their policy.
  policy: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

// `revision`'s legacy wiki head: null for a revision that has none, as every
// revision saved since the wiki was removed.
function legacyWikiOf(revision: z.infer<typeof REVISION>): string | null {
  return revision.wiki ?? null;
}

// The Reviewer's own integration of a hardened revision: `reviewed` is the
// revision that passed hardening, as `hardened` names it, and `revision` the
// revision the integration produced and checked. An integration never
// changes the trusted inputs, so a receipt that names two inputs revisions
// reads as none.
const INTEGRATION = z
  .object({ reviewed: REVISION, revision: REVISION })
  .refine((receipt) => receipt.reviewed.inputs === receipt.revision.inputs);

// An attempted mutation is not an own receipt. Persisted before the mutation,
// it permanently closes code-write/retry authority even if the response is lost.
const LANDING_ATTEMPT = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  target: z.string().min(1),
  branch: z.string().min(1),
  authorized: REVISION,
  hardened: REVISION,
  integration: INTEGRATION.nullable(),
  // Absent on historical REST merge attempts; never infer FF intent from a head.
  operation: z
    .object({
      kind: z.literal("fast-forward"),
      base: z.string().regex(FULL_SHA_PATTERN),
    })
    .optional(),
  result: z.string().regex(FULL_SHA_PATTERN).nullable(),
  // Cumulative audit evidence, never a lifetime confirmation limit.
  reads: z.number().int().nonnegative(),
});

type LandingAttempt = z.infer<typeof LANDING_ATTEMPT>;

export type { LandingAttempt };
export { FULL_SHA, INTEGRATION, LANDING_ATTEMPT, legacyWikiOf, REVISION };
