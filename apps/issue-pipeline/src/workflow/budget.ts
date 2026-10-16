// The issue's token budgets. Every session is charged up front, at its role's
// budget capped by the per-session cap, against one of two pools: the issue
// pool (`issueTokenBudget`), or the rebase pool (`rebaseTokenBudget`), which
// pays for conflict resolvers and for the re-checks after a rebase the merge
// stage asked for. This module alone knows the pools and their stop text.

import { noteEvent } from "./event-log.ts";
import type { IssueState, Role } from "./types.ts";

// How many of the latest sessions' roles the state keeps.
const KEPT_SESSIONS = 40;

interface Budgets {
  roles: Readonly<Record<Role, number>>;
  sessionCap: number;
  // The context no writer session may pass, in tokens (contextLimits.hard).
  hardLimit: number;
  issueBudget: number;
  rebaseBudget: number;
}

type Pool = "issue" | "rebase";

type BudgetState = Pick<
  IssueState,
  "allocated" | "rebaseAllocated" | "rechecking" | "sessions" | "log"
>;

type Charge =
  | { charged: true; pool: Pool }
  | { charged: false; pool: Pool; reason: string; detail: string };

interface ChargeOptions {
  at: Date;
  // How many sessions of the role; missing or 0 means one.
  count?: number;
  // The pool to charge; by default the rebase pool while re-checking, else
  // the issue pool.
  pool?: Pool;
}

// What a pool is called, its cap and what the issue has spent from it.
interface PoolTerms {
  key: string;
  cap: number;
  spent: number;
  unit: string;
}

// A missing or zero count means one session.
function sessionCount(count: number | undefined): number {
  if (count === undefined || count === 0) {
    return 1;
  }
  return count;
}

function poolTerms(budgets: Budgets, st: BudgetState, pool: Pool): PoolTerms {
  switch (pool) {
    case "issue":
      return {
        key: "issueTokenBudget",
        cap: budgets.issueBudget,
        spent: st.allocated,
        unit: "tokens",
      };
    case "rebase":
      return {
        key: "rebaseTokenBudget",
        cap: budgets.rebaseBudget,
        spent: st.rebaseAllocated ?? 0,
        unit: "rebase tokens",
      };
    default: {
      const unknown: never = pool;
      throw new Error(`unknown token pool ${String(unknown)}`);
    }
  }
}

// The token budget of one `role` session: its role's budget, capped by the
// per-session cap. Its preamble shows it, and the stage job's watchdog stops
// the session once its context passes it.
function sessionBudget(budgets: Budgets, role: Role): number {
  return Math.min(budgets.roles[role], budgets.sessionCap);
}

function sessionCost(
  budgets: Budgets,
  role: Role,
  count: number | undefined,
): number {
  return sessionBudget(budgets, role) * sessionCount(count);
}

// Whether `need.cost` more tokens fit `need.pool`, and if not, why.
function fits(
  budgets: Budgets,
  st: BudgetState,
  role: Role,
  need: { pool: Pool; cost: number },
): Charge {
  const { pool, cost } = need;
  const terms = poolTerms(budgets, st, pool);
  if (terms.spent + cost <= terms.cap) {
    return { charged: true, pool };
  }
  return {
    charged: false,
    pool,
    reason: `${pool} token budget exhausted`,
    detail: `Allocated ${terms.spent} of ${terms.cap} ${terms.unit} (${terms.key}); the next step (${role}) needs ${cost}.`,
  };
}

// Says whether one session of `role` would fit `pool`, without changing `st`.
function chargeCheck(
  budgets: Budgets,
  st: BudgetState,
  role: Role,
  pool: Pool,
): Charge {
  const cost = sessionCost(budgets, role, undefined);
  return fits(budgets, st, role, { pool, cost });
}

// The pool a charge goes to when the caller names none.
function defaultPool(st: BudgetState): Pool {
  if (st.rechecking === true) {
    return "rebase";
  }
  return "issue";
}

// Charges `count` sessions of `role` to a pool, by default the rebase pool
// while the issue is re-checking and the issue pool otherwise. When they fit,
// it adds them to the pool, records the role and logs the charge; when they
// don't, it leaves `st` alone and says why.
function chargeSession(
  budgets: Budgets,
  st: BudgetState,
  role: Role,
  options: ChargeOptions,
): Charge {
  const pool = options.pool ?? defaultPool(st);
  const cost = sessionCost(budgets, role, options.count);
  const charge = fits(budgets, st, role, { pool, cost });
  if (!charge.charged) {
    return charge;
  }
  if (pool === "rebase") {
    st.rebaseAllocated = (st.rebaseAllocated ?? 0) + cost;
  } else {
    st.allocated += cost;
  }
  st.sessions = [...(st.sessions ?? []), role].slice(-KEPT_SESSIONS);
  const { key } = poolTerms(budgets, st, pool);
  noteEvent(st, `charged ${role} ${cost} to ${key}`, options.at);
  return charge;
}

export type { Budgets, Charge, Pool };
export { chargeCheck, chargeSession, sessionBudget };
