// Closing split parents each tick (#378, `orchestrator-closes-parents`): the
// orchestrator runs close-parent's own code for each open split parent, so it
// closes one once every sub-issue is closed and at least one merged. The
// author never splits an issue, so these are parents grouped by hand. With
// one orchestrator per repo nothing else closes them, so no reservation is
// taken first. A closed parent is logged as `closed-parent`; a close that
// fails is logged as `close-parent-failed` and tried again on the next tick.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { CloseParentReply } from "../ops/finish.ts";
import { closeParent } from "../ops/finish.ts";
import { OpsError } from "../ops-error.ts";
import type { LogEntry } from "./log.ts";

// The stage a parent's log lines name.
const STAGE = "parent";

// What became of one split parent this tick: closed, still waiting on its
// sub-issues (and why), or failed (and why).
type ParentOutcome =
  | { issue: number; outcome: "closed" }
  | { issue: number; outcome: "waiting"; reason: string }
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

function closeOne(cfg: Config, issue: number): ParentOutcome {
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
      return {
        issue,
        outcome: "failed",
        reason: `close-parent failed: ${error.message}`,
      };
    }
    throw error;
  }
  return { issue, outcome: "closed" };
}

// The log line of a parent closed or failed; none for one still waiting.
function parentLines(outcome: ParentOutcome, at: string): LogEntry[] {
  const { issue } = outcome;
  switch (outcome.outcome) {
    case "closed":
      return [
        {
          at,
          issue,
          stage: STAGE,
          action: "closed-parent",
          reason: "sub-issues-done",
        },
      ];
    case "failed":
      return [
        {
          at,
          issue,
          stage: STAGE,
          action: "close-parent-failed",
          reason: outcome.reason,
        },
      ];
    case "waiting":
      return [];
    default: {
      const unknown: never = outcome;
      throw new Error(`unknown parent outcome ${JSON.stringify(unknown)}`);
    }
  }
}

// Closes each of the open split `parents` that is done and returns what
// became of each. A gh or reply failure is reported, not thrown.
function closeParents(
  cfg: Config,
  parents: readonly number[],
): ParentOutcome[] {
  return parents.map((issue) => closeOne(cfg, issue));
}

export type { ParentOutcome };
export { closeParents, parentLines };
