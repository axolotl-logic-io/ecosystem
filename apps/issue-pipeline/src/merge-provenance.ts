// Immutable authorization and attempted-merge evidence shared by state and recovery.
import { z } from "zod";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

// What a review or a merge saw: the code head and the trusted-inputs
// revision. `wiki` is legacy: a revision saved while the pipeline had a wiki
// names its wiki head (null with no wiki commits). The pipeline writes none,
// and an absent one reads as null (legacyWikiOf).
const REVISION = z.object({
  code: z.string().nullable(),
  wiki: z.string().nullable().optional(),
  inputs: z.string(),
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

// An attempted mutation is not an own receipt. Persisted before the POST,
// it permanently closes code-write/retry authority even if the response is lost.
const MERGE_ATTEMPT = z.object({
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  target: z.string().min(1),
  branch: z.string().min(1),
  authorized: REVISION,
  hardened: REVISION,
  integration: INTEGRATION.nullable(),
  result: z.string().regex(FULL_SHA_PATTERN).nullable(),
  // Cumulative audit evidence, never a lifetime confirmation limit.
  reads: z.number().int().nonnegative(),
});

type MergeAttempt = z.infer<typeof MERGE_ATTEMPT>;

export type { MergeAttempt };
export { INTEGRATION, legacyWikiOf, MERGE_ATTEMPT, REVISION };
