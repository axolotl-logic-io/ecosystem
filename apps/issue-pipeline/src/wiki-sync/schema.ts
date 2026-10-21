// Local recovery records are evidence, never signed GitHub authority.
import { z } from "zod";
import { validatedWriteState } from "../saved-state.ts";

const OID = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const ID = z.uuid();
const SAVED_AUTHORITY = z.unknown().transform((raw) => {
  const { number } = z
    .object({ number: z.number().int().positive() })
    .parse(raw);
  return validatedWriteState(raw, number);
});
const OPERATOR_DECISION = z.strictObject({
  kind: z.literal("pre-checkpoint-decision"),
  rationale: z.string().min(1),
  evidence: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  warning: z.string().min(1),
});
const ABANDONED = z.strictObject({ id: ID });
const PREPARATION = z.strictObject({
  version: z.literal(1),
  id: ID,
  repo: z.string().min(1),
  remote: z.string().min(1),
  base: z.string().min(1),
  wikiBranch: z.string().min(1),
  issue: z.number().int().positive(),
  branch: z.string().min(1),
  lane: z.string().min(1),
  job: z.string().min(1),
  checkout: z.string().min(1),
  old: OID,
  target: OID,
  expected: OID.nullable(),
  authority: SAVED_AUTHORITY,
  at: z.iso.datetime(),
});
const INTENT = z.strictObject({ id: ID, new: OID });
const COMPLETION = z.strictObject({
  id: ID,
  new: OID,
  response: z.enum(["acknowledged", "lost"]),
});
const SELECTION = z.strictObject({
  id: ID,
  new: OID,
  private: OID,
  retained: z.string().min(1),
  retainedIdentity: z.strictObject({
    device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(),
  }),
  basis: z.string().min(1),
  kind: z.enum(["checkpoint", "operator"]),
});
type Preparation = z.infer<typeof PREPARATION>;
type Intent = z.infer<typeof INTENT>;
type Selection = z.infer<typeof SELECTION>;

export type { Intent, Preparation, Selection };
export {
  ABANDONED,
  COMPLETION,
  ID,
  INTENT,
  OID,
  OPERATOR_DECISION,
  PREPARATION,
  SELECTION,
};
