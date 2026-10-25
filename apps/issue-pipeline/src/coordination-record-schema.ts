// A coordination record's schema, in all three versions. Version 2 renamed a
// request's `identity` to `binding` (#166) and changed nothing else;
// transitions are the same in both. Version 3 is the version of a shared
// resource's slot scope: the same request and transitions, plus a consumer's
// `register` and `done` reports. Records are written as version 2, or 3 in a
// resource scope, and read in any version: an old request reads as the
// version 2 record it is equivalent to, with its key renamed, and is never
// rewritten. Which scope each version may name is coordination-records.ts's
// rule.
import { z } from "zod";

// The version of every record in a resource slot's scope, and only of those.
const RESOURCE_RECORD_VERSION = 3;
const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const INVOCATION_BINDING = z.strictObject({
  instance: z.string().uuid(),
  lane: z.string().min(1),
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
});
// One consumer of a resource slot, such as a model session, named by its
// kind and an id unique within that kind.
const CONSUMER = z.strictObject({
  kind: z.string().min(1),
  id: z.string().min(1),
});
const REQUEST_V1 = z.strictObject({
  version: z.literal(1),
  scope: z.string().min(1),
  operation: z.string().uuid(),
  kind: z.literal("request"),
  identity: INVOCATION_BINDING,
  token: SHA,
});
const RECORD = z.discriminatedUnion("kind", [
  z.strictObject({
    version: z.union([z.literal(2), z.literal(RESOURCE_RECORD_VERSION)]),
    scope: z.string().min(1),
    operation: z.string().uuid(),
    kind: z.literal("request"),
    binding: INVOCATION_BINDING,
    token: SHA,
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

// `raw` as a current record, or null when it is no version.
function currentRecord(raw: unknown): Record | null {
  const legacy = REQUEST_V1.safeParse(raw);
  if (legacy.success) {
    const { identity, ...rest } = legacy.data;
    return { ...rest, version: 2, binding: identity };
  }
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
