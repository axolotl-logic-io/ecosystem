// The reply of the merge op, or of finish-wiki for a change that lives only
// in the wiki (src/ops/merge.ts, finish.ts), as the finalizer reads it:
// merged, with the wiki's changes published or not; queued behind an older
// PR (decision merge-order); deferred to a rebase, behind its base or in
// conflict; or refused by GitHub for any other reason. Parsed with zod: the
// roles never run in workflow.js's sandbox. Pure.

import { z } from "zod";

type MergeReply =
  | { kind: "merged"; published: boolean }
  | { kind: "queued"; waitingFor: number; waitingForPr: number }
  | { kind: "deferred"; reason: "behind" | "conflict" }
  | { kind: "refused"; reason: string | null };

const MERGED = z.looseObject({
  merged: z.literal(true),
  published: z.boolean().optional(),
});

const QUEUED = z.looseObject({
  reason: z.literal("queued"),
  waitingFor: z.number(),
  waitingForPr: z.number(),
});

const DEFERRED = z.looseObject({
  reason: z.enum(["behind", "conflict"]),
});

const REFUSED = z.looseObject({ reason: z.string().nullish() });

// What `reply` says of the merge; a reply that names no reason reads as a
// refusal with none.
function mergeReplyOf(reply: unknown): MergeReply {
  const merged = MERGED.safeParse(reply);
  if (merged.success) {
    return { kind: "merged", published: merged.data.published !== false };
  }
  const queued = QUEUED.safeParse(reply);
  if (queued.success) {
    const { waitingFor, waitingForPr } = queued.data;
    return { kind: "queued", waitingFor, waitingForPr };
  }
  const deferred = DEFERRED.safeParse(reply);
  if (deferred.success) {
    return { kind: "deferred", reason: deferred.data.reason };
  }
  const refused = REFUSED.safeParse(reply);
  let reason: string | null = null;
  if (refused.success) {
    reason = refused.data.reason ?? null;
  }
  return { kind: "refused", reason };
}

export type { MergeReply };
export { mergeReplyOf };
