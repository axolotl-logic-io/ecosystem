// A coordination record's schema. Version 2 is an issue scope's request and
// its transitions. Version 3 is the version of a shared resource's slot
// scope: the same request and transitions, plus a consumer's `register` and
// `done` reports, and its request declares the capacity, `cap`, that its
// caller reserved under. A declared cap is evidence of what each caller
// assumed, not a trusted capacity policy. Any other version reads as no
// record, which holds its scope. Which scope each version may name is
// coordination-records.ts's rule.
import { BINDING } from "@ecosystem/db/protocol";
import { z } from "zod";

// The version of every record in a resource slot's scope, and only of those.
const RESOURCE_RECORD_VERSION = 3;
const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const INVOCATION_BINDING: typeof BINDING = BINDING;
// One consumer of a resource slot, such as a model session, named by its
// kind and an id unique within that kind.
const CONSUMER = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
});
const RECORD = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.union([z.literal(2), z.literal(RESOURCE_RECORD_VERSION)]),
    scope: z.string().min(1),
    operation: z.string().uuid(),
    kind: z.literal("request"),
    binding: INVOCATION_BINDING,
    token: SHA,
    // Present on a version 3 request, and only there.
    cap: z.number().int().positive().optional(),
  }),
  z.strictObject({
    version: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(RESOURCE_RECORD_VERSION),
    ]),
    scope: z.string().min(1),
    operation: z.string().uuid(),
    kind: z.enum(["confirm", "release", "cancel", "save"]),
    request: z.number().int().positive(),
    instance: z.string().uuid(),
    evidence: z.json().optional(),
  }),
  z.strictObject({
    version: z.literal(RESOURCE_RECORD_VERSION),
    scope: z.string().min(1),
    operation: z.string().uuid(),
    kind: z.enum(["register", "done"]),
    request: z.number().int().positive(),
    instance: z.string().uuid(),
    consumer: CONSUMER,
  }),
]);
type Record = z.infer<typeof RECORD>;

// `raw` as a current record, or null when it is none.
function currentRecord(raw: unknown): Record | null {
  return RECORD.safeParse(raw).data ?? null;
}

export type { Record };
export {
  CONSUMER,
  currentRecord,
  INVOCATION_BINDING,
  RECORD,
  RESOURCE_RECORD_VERSION,
};
