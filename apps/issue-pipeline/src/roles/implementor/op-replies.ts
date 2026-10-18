// The parts of the ops' replies the implementor reads, checked as they
// arrive, so a reply that lacks a field the role depends on fails the stage
// instead of being read as a success.

import { z } from "zod";
import type { OpName, RoleContext } from "../../job/role-context.ts";

const SHA = z.string().min(1);

const START_PR_REPLY = z.looseObject({
  pr: z.number().int().positive(),
  headSha: SHA,
});

// A rebase that conflicted, left stopped in the checkout when `inRebase`.
const CONFLICT = z.looseObject({
  conflict: z.literal(true),
  inRebase: z.boolean(),
  conflicts: z.array(z.string()),
  baseSha: SHA,
});

// sync-base and wiki-sync: a clean rebase (sync-base pushes one that changed
// the branch; the wiki's is pushed with the work), or a conflict.
const SYNC_REPLY = z.union([
  z.looseObject({ conflict: z.literal(false), changed: z.boolean() }),
  CONFLICT,
]);

// finish-sync and finish-wiki-sync.
const FINISH_REPLY = z.union([
  z.looseObject({ resolved: z.literal(true) }),
  z.looseObject({ resolved: z.literal(false), reason: z.string() }),
]);

const CHECK = z.looseObject({
  id: z.string(),
  pass: z.boolean(),
  detail: z.string(),
  log: z.string().optional(),
  tail: z.string().optional(),
});

const VERIFY_REPLY = z.looseObject({
  pass: z.boolean(),
  headSha: SHA,
  checks: z.array(CHECK),
});

const WIKI_CHECK_REPLY = z.looseObject({
  pass: z.boolean(),
  checks: z.array(CHECK),
});

// open-pr and push: the code head after the push and what the work changes.
const PUSH_REPLY = z.looseObject({
  headSha: SHA,
  codeChanged: z.boolean(),
  wikiAhead: z.number().int().nonnegative(),
});

const OPEN_PR_REPLY = PUSH_REPLY.extend({ pr: z.number().int().positive() });

type Check = z.infer<typeof CHECK>;
type Conflict = z.infer<typeof CONFLICT>;

// Runs op `name` and checks its reply against `schema`. A reply that doesn't
// fit throws, naming the op, as a failed op does.
async function opReply<T>(
  ctx: RoleContext,
  name: OpName,
  payload: object,
  schema: z.ZodType<T>,
): Promise<T> {
  const reply = await ctx.op(name, payload);
  const parsed = schema.safeParse(reply);
  if (!parsed.success) {
    throw new Error(
      `the ${name} op's reply is not what the implementor reads: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export type { Check, Conflict };
export {
  FINISH_REPLY,
  OPEN_PR_REPLY,
  opReply,
  PUSH_REPLY,
  START_PR_REPLY,
  SYNC_REPLY,
  VERIFY_REPLY,
  WIKI_CHECK_REPLY,
};
