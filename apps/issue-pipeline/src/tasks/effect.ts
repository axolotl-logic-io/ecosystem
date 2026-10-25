// A task action's effect op: one ops-child request that checks the run's
// recorded attempt and every prerequisite again on fresh reads, makes the
// task's effect, and records its determined verdict itself. The reply is
// parsed here; a request whose outcome can't be read stays unknown, never
// failed, so nothing retries it.

import { z } from "zod";
import type { ActionContext, ActionEnd } from "../domain.ts";
import { SHA, VERDICT } from "../domain.ts";
import { messageOf } from "./message.ts";
import { ended } from "./module.ts";

const EFFECT_REPLY = z.looseObject({
  verdict: VERDICT,
  reason: z.string().min(1),
  produced: SHA.optional(),
});

type EffectReply = z.infer<typeof EFFECT_REPLY>;

async function effectReply(
  ctx: ActionContext,
  op: string,
  payload: object,
): Promise<EffectReply> {
  try {
    return EFFECT_REPLY.parse(await ctx.op(op, payload));
  } catch (error) {
    return {
      verdict: "unknown",
      reason: `${op} is uncertain: ${messageOf(error)}`,
    };
  }
}

function endOf(reply: EffectReply): ActionEnd {
  if (reply.produced !== undefined) {
    return ended(reply.verdict, reply.reason, reply.produced);
  }
  return ended(reply.verdict, reply.reason);
}

// Runs the action's effect op `op` for this run.
async function effectEnd(
  ctx: ActionContext,
  op: string,
  extra: object = {},
): Promise<ActionEnd> {
  return endOf(
    await effectReply(ctx, op, {
      number: ctx.workItem.number,
      binding: ctx.binding,
      run: { id: ctx.run.id },
      ...extra,
    }),
  );
}

// A read-only recovery under a new action: the reconcile op settles the
// binding's original unsettled run from reads, linking this reconciling
// action in its receipt, or leaves it unknown and held.
async function recoverEnd(ctx: ActionContext, op: string): Promise<ActionEnd> {
  return endOf(
    await effectReply(ctx, op, {
      number: ctx.workItem.number,
      binding: ctx.binding,
      reconciler: ctx.run.id,
    }),
  );
}

export type { EffectReply };
export { EFFECT_REPLY, effectEnd, recoverEnd };
