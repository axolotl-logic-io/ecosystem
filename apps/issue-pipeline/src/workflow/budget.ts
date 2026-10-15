// The issue's token budget. Every session is charged up front, at its role's
// budget capped by the per-session cap, against the issue's total budget.

import type { IssueState, Role } from "./types.ts";

// How many of the latest sessions' roles the state keeps.
const KEPT_SESSIONS = 40;

interface Budgets {
  roles: Readonly<Record<Role, number>>;
  sessionCap: number;
  issueBudget: number;
}

type BudgetState = Pick<IssueState, "allocated" | "sessions">;

type Charge = { charged: true } | { charged: false; detail: string };

// A missing or zero count means one session.
function sessionCount(count: number | undefined): number {
  if (count === undefined || count === 0) {
    return 1;
  }
  return count;
}

// Charges `count` sessions of `role` to the issue (0 or no count means one).
// When they fit, it adds them to `st` and records the role; when they don't,
// it leaves `st` alone and says why.
function chargeSession(
  budgets: Budgets,
  st: BudgetState,
  role: Role,
  count?: number,
): Charge {
  const cost =
    Math.min(budgets.roles[role], budgets.sessionCap) * sessionCount(count);
  if (st.allocated + cost > budgets.issueBudget) {
    return {
      charged: false,
      detail: `Allocated ${st.allocated} of ${budgets.issueBudget} tokens; the next step (${role}) needs ${cost}.`,
    };
  }
  st.allocated += cost;
  st.sessions = [...(st.sessions ?? []), role].slice(-KEPT_SESSIONS);
  return { charged: true };
}

export type { Budgets, Charge };
export { chargeSession };
