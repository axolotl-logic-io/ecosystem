// Charging an issue's sessions against its token budget.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chargeSession } from "../src/workflow/budget.ts";

const KEPT_SESSIONS = 40;
const TRIAGE = 50_000;
const REVIEWER = 60_000;
const SESSION_CAP = 150_000;
const ISSUE_BUDGET = 1_000_000;
const REVIEWERS = 3;

const budgets = {
  // The fixer's budget is over the session cap.
  roles: { triage: TRIAGE, reviewer: REVIEWER, fixer: SESSION_CAP + 1 },
  sessionCap: SESSION_CAP,
  issueBudget: ISSUE_BUDGET,
};

test("a session costs its role's budget, capped per session", () => {
  const st = { allocated: 0 };
  assert.deepEqual(chargeSession(budgets, st, "triage"), { charged: true });
  assert.deepEqual(chargeSession(budgets, st, "fixer"), { charged: true });
  assert.equal(st.allocated, TRIAGE + SESSION_CAP);
  assert.deepEqual(st.sessions, ["triage", "fixer"]);
});

test("several sessions cost the role's budget each, and record the role once", () => {
  const st = { allocated: 0, sessions: [] };
  chargeSession(budgets, st, "reviewer", REVIEWERS);
  assert.equal(st.allocated, REVIEWER * REVIEWERS);
  assert.deepEqual(st.sessions, ["reviewer"]);
});

test("a zero count charges one session", () => {
  const st = { allocated: 0 };
  chargeSession(budgets, st, "reviewer", 0);
  assert.equal(st.allocated, REVIEWER);
});

test("a session that would pass the budget by one token is refused", () => {
  const allocated = ISSUE_BUDGET - REVIEWER + 1;
  const st = { allocated, sessions: ["spec"] };
  assert.deepEqual(chargeSession(budgets, st, "reviewer"), {
    charged: false,
    detail:
      "Allocated 940001 of 1000000 tokens; the next step (reviewer) needs 60000.",
  });
  assert.deepEqual(st, { allocated, sessions: ["spec"] });
});

test("a session that reaches the budget exactly is charged", () => {
  const st = { allocated: ISSUE_BUDGET - REVIEWER };
  assert.deepEqual(chargeSession(budgets, st, "reviewer"), { charged: true });
  assert.equal(st.allocated, ISSUE_BUDGET);
});

test("only the latest 40 sessions are kept", () => {
  const sessions = Array.from({ length: KEPT_SESSIONS }, () => "triage");
  const st = { allocated: 0, sessions };
  chargeSession(budgets, st, "fixer");
  assert.equal(st.sessions.length, KEPT_SESSIONS);
  assert.equal(st.sessions.at(-1), "fixer");
  assert.equal(st.sessions.at(0), "triage");
});
