// The sessions' context budgets: each role's budget, capped by the
// per-session cap. They bound a session's context, not the issue's spend
// (budgets-bound-context, Axlog, 2026-10-16): a session's preamble shows its
// budget, and the orchestrator's watchdog stops a writer session past it.

import type { Role } from "./types.ts";

interface Budgets {
  roles: Readonly<Record<Role, number>>;
  sessionCap: number;
  // The context no writer session may pass, in tokens (contextLimits.hard).
  hardLimit: number;
}

// The context budget of one `role` session: its role's budget, capped by the
// per-session cap. Its preamble shows it, and the orchestrator's watchdog
// stops a writer session, and no other, once its context passes it.
function sessionBudget(budgets: Budgets, role: Role): number {
  return Math.min(budgets.roles[role], budgets.sessionCap);
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
export { launchBudget, sessionBudget };
