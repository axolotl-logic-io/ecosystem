// A coordination record's schema, in both versions. Version 2 renamed a
// request's `identity` to `binding` (#166) and changed nothing else;
// transitions are the same in both. Records are written as version 2 and
// read in either: an old request reads as the version 2 record it is
// equivalent to, with its key renamed, and is never rewritten.
import { z } from "zod";

const SHA = z.string().regex(/^[0-9a-f]{40}$/u);
const INVOCATION_BINDING = z.strictObject({
  instance: z.string().uuid(),
  lane: z.string().min(1),
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  repo: z.string().min(1),
  base: z.string().min(1),
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
    version: z.literal(2),
    scope: z.string().min(1),
    operation: z.string().uuid(),
    kind: z.literal("request"),
    binding: INVOCATION_BINDING,
    token: SHA,
  }),
  z.strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    scope: z.string().min(1),
    operation: z.string().uuid(),
    kind: z.enum(["confirm", "release", "cancel", "save"]),
    request: z.number().int().positive(),
    instance: z.string().uuid(),
    evidence: z.json().optional(),
  }),
]);
type Record = z.infer<typeof RECORD>;

// `raw` as a current record, or null when it is neither version.
function currentRecord(raw: unknown): Record | null {
  const legacy = REQUEST_V1.safeParse(raw);
  if (legacy.success) {
    const { identity, ...rest } = legacy.data;
    return { ...rest, version: 2, binding: identity };
  }
  return RECORD.safeParse(raw).data ?? null;
}

export type { Record };
export { currentRecord, INVOCATION_BINDING, RECORD };
