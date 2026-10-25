// reconcile-merge (merge-recovery.ts), which with a Land binding also
// settles that Land from the read-only receipt, as a merge replay does: a
// confirmed own merge of exactly R is its pass; anything else leaves it
// unsettled. A settled Land then retires what an earlier invocation of the
// issue left of the target's integration turn (land-turn.ts).

import { z } from "zod";
import type { Config } from "../config.ts";
import { parseRequest } from "../process.ts";
import { BINDING } from "../task-result-records.ts";
import { settleLand } from "./land-task.ts";
import { retireSettledTurn } from "./land-turn.ts";
import type { ConfirmationClock } from "./merge-recovery.ts";
import { reconcileMerge } from "./merge-recovery.ts";

const RECONCILE_REQUEST = z.looseObject({
  number: z.number().int(),
  binding: BINDING.optional(),
});

function reconcileLand(
  cfg: Config,
  request: unknown,
  clock?: ConfirmationClock,
): ReturnType<typeof reconcileMerge> {
  const req = parseRequest(RECONCILE_REQUEST, "reconcile-merge", request);
  const reply = reconcileMerge(cfg, request, clock);
  if (req.binding !== undefined) {
    settleLand(cfg, req.number, req.binding, reply);
    retireSettledTurn(cfg, req.number);
  }
  return reply;
}

export { reconcileLand };
