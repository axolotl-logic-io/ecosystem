// The parts of the ops' replies the roles read, checked as they arrive, so a
// reply that lacks a field a role depends on fails the stage instead of
// being read as a success.

import { z } from "zod";
import type { OpName, RoleContext } from "../job/role-context.ts";
import { unreadableReply } from "../job/role-context.ts";
import type { IssueState } from "../state.ts";

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

// sync-base: a clean rebase (pushed when it changed the branch), or a
// conflict.
const SYNC_REPLY = z.union([
  z.looseObject({ conflict: z.literal(false), changed: z.boolean() }),
  CONFLICT,
]);

// A controlled conflict-limit stop has saved evidence and retained the rebase.
const RETAINED_CONFLICT_REPLY = z.looseObject({
  resolved: z.literal(false),
  retained: z.literal(true),
  reason: z.string().min(1),
});

// finish-sync.
const FINISH_REPLY = z.union([
  CONFLICT,
  z.looseObject({
    conflict: z.literal(false).default(false),
    resolved: z.literal(true),
  }),
  z.looseObject({
    conflict: z.literal(false).default(false),
    resolved: z.literal(false),
    reason: z.string(),
  }),
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

// open-pr and push: the code head after the push and what the work changes.
const PUSH_REPLY = z.looseObject({
  headSha: SHA,
  codeChanged: z.boolean(),
});

const OPEN_PR_REPLY = PUSH_REPLY.extend({ pr: z.number().int().positive() });

// ready-pr: the PR is ready for review, whether this call or an earlier one
// marked it.
const READY_PR_REPLY = z.looseObject({
  pr: z.number().int().positive(),
  ready: z.literal(true),
});

type Check = z.infer<typeof CHECK>;
type Conflict = z.infer<typeof CONFLICT>;
type SyncReply = z.infer<typeof SYNC_REPLY>;

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
    throw unreadableReply(name, z.prettifyError(parsed.error));
  }
  return parsed.data;
}

// Marks the issue's PR ready for review once `state`, already saved, holds
// its approval. The op guards it and succeeds again on a PR already ready; a
// refusal throws, so a PR that stays a draft is never read as ready. A change
// with no code PR (none, or its code already landed) needs no ready PR.
async function readyPr(ctx: RoleContext, state: IssueState): Promise<void> {
  if (state.pr === null || state.codeMerged !== null) {
    return;
  }
  const reply = await opReply(
    ctx,
    "ready-pr",
    { number: ctx.issue, state },
    READY_PR_REPLY,
  );
  if (reply.pr !== state.pr) {
    throw unreadableReply(
      "ready-pr",
      `it readied PR #${reply.pr}, not the issue's PR #${state.pr}`,
    );
  }
}

export type { Check, Conflict, SyncReply };
export {
  FINISH_REPLY,
  OPEN_PR_REPLY,
  opReply,
  PUSH_REPLY,
  RETAINED_CONFLICT_REPLY,
  readyPr,
  START_PR_REPLY,
  SYNC_REPLY,
  VERIFY_REPLY,
};
