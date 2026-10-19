// Immutable authorization and attempted-merge evidence shared by state and recovery.
import { z } from "zod";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

// What a review or a merge saw: the code head, the wiki head (null when the
// issue has no wiki commits) and the trusted-inputs revision.
const REVISION = z.object({
  code: z.string().nullable(),
  wiki: z.string().nullable(),
  inputs: z.string(),
});

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
  reads: z.number().int().nonnegative(),
});

type MergeAttempt = z.infer<typeof MERGE_ATTEMPT>;

export type { MergeAttempt };
export { INTEGRATION, MERGE_ATTEMPT, REVISION };
