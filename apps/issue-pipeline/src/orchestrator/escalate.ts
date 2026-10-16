// The orchestrator's escalations (#235): what the watchdog's rules can't
// settle, raised once each for the maintainers. An open issue escalates when
// it carries a stop label the rules didn't expect (any stop but the job stop
// the rules end in, and the budget stop the watchdog made itself for the
// issue's current job), the acceptance stop (an acceptance fail),
// or agent:needs-info. Each label escalates once while the issue carries it,
// and again if it is removed and comes back. Pure: the tick writes them.

import { LABELS } from "../labels.ts";
import { STOPS } from "../stops.ts";

// The stop codes the watchdog's rules end in, which need no escalation.
const EXPECTED_STOPS: readonly string[] = ["job"];
const ACCEPTANCE_STOP = "acceptance";
const BUDGET_STOP = "budget";

type EscalationReason = "unexpected-stop" | "acceptance-fail" | "needs-info";

// An open issue's labels, the stage its saved state names, and whether the
// watchdog stopped its current job for its budget.
interface FlaggedIssue {
  issue: number;
  stage: string | null;
  labels: readonly string[];
  budgetStopped: boolean;
}

interface Escalation {
  at: string;
  issue: number;
  stage: string;
  action: "escalated";
  reason: EscalationReason;
  label: string;
}

interface Escalate {
  escalations: Escalation[];
  // What is escalated now, as `<issue> <label>`.
  escalated: string[];
}

function reasonOf(
  label: string,
  budgetStopped: boolean,
): EscalationReason | null {
  if (label === LABELS.needsInfo.name) {
    return "needs-info";
  }
  const stop = STOPS.find((s) => s.label.name === label);
  if (stop === undefined || EXPECTED_STOPS.includes(stop.code)) {
    return null;
  }
  if (stop.code === BUDGET_STOP && budgetStopped) {
    return null;
  }
  if (stop.code === ACCEPTANCE_STOP) {
    return "acceptance-fail";
  }
  return "unexpected-stop";
}

// The escalations `issues` raise as of `now` that `escalated` doesn't hold
// yet, and what is escalated after them.
function escalate(
  issues: readonly FlaggedIssue[],
  escalated: readonly string[],
  now: Date,
): Escalate {
  const at = now.toISOString();
  const escalations: Escalation[] = [];
  const held: string[] = [];
  for (const { issue, stage, labels, budgetStopped } of issues) {
    for (const label of labels) {
      const reason = reasonOf(label, budgetStopped);
      const id = `${issue} ${label}`;
      if (reason !== null) {
        held.push(id);
      }
      if (reason !== null && !escalated.includes(id)) {
        const action = "escalated";
        const where = { at, issue, stage: stage ?? "none" };
        escalations.push({ ...where, action, reason, label });
      }
    }
  }
  return { escalations, escalated: held };
}

export type { Escalation, FlaggedIssue };
export { escalate };
