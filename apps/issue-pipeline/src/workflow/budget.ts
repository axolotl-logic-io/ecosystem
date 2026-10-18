// The sessions' context budgets: each role's budget, capped by the
// per-session cap. They bound a session's context, not the issue's spend
// (budgets-bound-context, Axlog, 2026-10-16): a session's preamble shows its
// budget, and the orchestrator's watchdog stops a writer session past it.

import type { Role } from "./types.ts";

interface Budgets {
  roles: Readonly<Record<Role, number>>;
  sessionCap: number;
  // The context past which a writer session wraps up and hands off, in
  // tokens (contextLimits.soft).
  softLimit: number;
  // The context no writer session may pass, in tokens (contextLimits.hard).
  hardLimit: number;
}

// The context budget of one `role` session: its role's budget, capped by the
// per-session cap. Its preamble shows it, and the orchestrator's watchdog
// stops a writer session, and no other, once its context passes it.
function sessionBudget(budgets: Budgets, role: Role): number {
  return Math.min(budgets.roles[role], budgets.sessionCap);
}

// The most context an issue, or one part of a split issue, may need without
// splitting, in tokens: two implementer sessions, each wrapping up at
// contextLimits.soft (roles-6-10-scope). Triage and the spec writer size the
// issue against it.
function splitBound(budgets: Pick<Budgets, "softLimit">): number {
  return 2 * budgets.softLimit;
}

// A session's context budget and the role it is the budget of.
interface LaunchBudget {
  budgetRole: Role;
  tokenBudget: number;
}

// The budget of one `role` session, with its role.
function launchBudget(budgets: Budgets, role: Role): LaunchBudget {
  return { budgetRole: role, tokenBudget: sessionBudget(budgets, role) };
}

export type { Budgets, LaunchBudget };
export { launchBudget, sessionBudget, splitBound };
