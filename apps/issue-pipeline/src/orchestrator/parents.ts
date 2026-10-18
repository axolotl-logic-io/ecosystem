// Closing split parents each tick (#378): the orchestrator runs close-parent's
// own code for each open split parent, so it closes one once every sub-issue
// is closed and at least one merged, as a lane's sweep does. It first reserves
// the parents as the sweep `orchestrator`, so it skips one a lane reserved
// lately, and its own reservations never hold back its next tick. A closed
// parent is logged as `closed-parent`; a close that fails is escalated with
// the agent:split label and tried again on the next tick.

import { z } from "zod";
import type { Config } from "../config.ts";
import { LABELS } from "../labels.ts";
import type { CloseParentReply } from "../ops/finish.ts";
import { closeParent } from "../ops/finish.ts";
import { reserveParents } from "../ops/sweep.ts";
import { OpsError } from "../process.ts";
import { logDecisions, logEscalations } from "./log.ts";

// The sweepId the orchestrator reserves parents as.
const SWEEP_ID = "orchestrator";
// The stage a parent's log lines name.
const STAGE = "split";

// What became of one split parent this tick: closed, still waiting on its
// sub-issues (and why), reserved by another sweep, or failed (and why).
type ParentOutcome =
  | { issue: number; outcome: "closed" }
  | { issue: number; outcome: "waiting"; reason: string }
  | { issue: number; outcome: "reserved" }
  | { issue: number; outcome: "failed"; reason: string };

function waitingReason(
  reply: Exclude<CloseParentReply, { closed: true }>,
): string {
  if ("open" in reply) {
    const open = reply.open.map((n) => `#${n}`).join(", ");
    return `sub-issues open: ${open}`;
  }
  return reply.reason;
}

function closeOne(cfg: Config, issue: number, at: string): ParentOutcome {
  try {
    const reply = closeParent(cfg, { number: issue });
    if (!reply.closed) {
      return { issue, outcome: "waiting", reason: waitingReason(reply) };
    }
  } catch (error: unknown) {
    if (
      error instanceof OpsError ||
      error instanceof z.ZodError ||
      error instanceof SyntaxError
    ) {
      const reason = `close-parent failed: ${error.message}`;
      const action = "escalated";
      const label = LABELS.split.name;
      logEscalations(cfg, [{ at, issue, stage: STAGE, action, reason, label }]);
      return { issue, outcome: "failed", reason };
    }
    throw error;
  }
  const reason = "sub-issues-done";
  logDecisions(cfg, [
    { at, issue, stage: STAGE, action: "closed-parent", reason },
  ]);
  return { issue, outcome: "closed" };
}

// Closes each of the open split `parents` that is done, as of `now`, and
// returns what became of each. A gh or reply failure is escalated, not
// thrown.
function closeParents(
  cfg: Config,
  parents: readonly number[],
  now: Date,
): ParentOutcome[] {
  if (parents.length === 0) {
    return [];
  }
  const mine = reserveParents(cfg, SWEEP_ID, parents, now.getTime());
  const at = now.toISOString();
  return parents.map((issue): ParentOutcome => {
    if (!mine.includes(issue)) {
      return { issue, outcome: "reserved" };
    }
    return closeOne(cfg, issue, at);
  });
}

export type { ParentOutcome };
export { closeParents };
