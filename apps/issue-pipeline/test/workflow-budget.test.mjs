// @ts-check
// A session's context budget: its role's budget, capped per session. It bounds
// one session's context, never the issue's spend (budgets-bound-context).
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchBudget, sessionBudget } from "../src/workflow/budget.ts";

/** @import { Budgets } from "../src/workflow/budget.ts" */

const TRIAGE = 50_000;
const SESSION_CAP = 150_000;

/** @type {Budgets} */
const budgets = {
  // The ciFixer's budget is over the session cap.
  roles: {
    triage: TRIAGE,
    reviewer: 60_000,
    fixer: 100_000,
    ciFixer: SESSION_CAP + 1,
    spec: 80_000,
    implementer: 150_000,
    aggregator: 20_000,
    rereviewer: 40_000,
    verifier: 60_000,
  },
  sessionCap: SESSION_CAP,
  hardLimit: 175_000,
};

test("a session's budget is its role's, capped per session", () => {
  assert.equal(sessionBudget(budgets, "triage"), TRIAGE);
  assert.equal(sessionBudget(budgets, "ciFixer"), SESSION_CAP);
});

test("a launch carries its session's budget and the role it is the budget of", () => {
  assert.deepEqual(launchBudget(budgets, "ciFixer"), {
    budgetRole: "ciFixer",
    tokenBudget: SESSION_CAP,
  });
});
