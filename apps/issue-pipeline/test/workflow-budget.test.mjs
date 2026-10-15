// Charging an issue's sessions against its token budgets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chargeCheck, chargeSession } from "../src/workflow/budget.ts";

const KEPT_SESSIONS = 40;
const TRIAGE = 50_000;
const REVIEWER = 60_000;
const FIXER = 100_000;
const SESSION_CAP = 150_000;
const ISSUE_BUDGET = 1_000_000;
const REBASE_BUDGET = 500_000;
const REVIEWERS = 3;
const NEAR_FULL = 980_000;
const at = new Date("2026-10-15T12:00:00Z");

const budgets = {
  // The ciFixer's budget is over the session cap.
  roles: {
    triage: TRIAGE,
    reviewer: REVIEWER,
    fixer: FIXER,
    ciFixer: SESSION_CAP + 1,
  },
  sessionCap: SESSION_CAP,
  issueBudget: ISSUE_BUDGET,
  rebaseBudget: REBASE_BUDGET,
};

test("a session costs its role's budget, capped per session", () => {
  const st = { allocated: 0 };
  assert.deepEqual(chargeSession(budgets, st, "triage", { at }), {
    charged: true,
    pool: "issue",
  });
  assert.deepEqual(chargeSession(budgets, st, "ciFixer", { at }), {
    charged: true,
    pool: "issue",
  });
  assert.equal(st.allocated, TRIAGE + SESSION_CAP);
  assert.deepEqual(st.sessions, ["triage", "ciFixer"]);
});

test("several sessions cost the role's budget each, and record the role once", () => {
  const st = { allocated: 0, sessions: [] };
  chargeSession(budgets, st, "reviewer", { at, count: REVIEWERS });
  assert.equal(st.allocated, REVIEWER * REVIEWERS);
  assert.deepEqual(st.sessions, ["reviewer"]);
  assert.deepEqual(st.log, [
    "2026-10-15T12:00Z charged reviewer 180000 to issueTokenBudget",
  ]);
});

test("a zero count charges one session", () => {
  const st = { allocated: 0 };
  chargeSession(budgets, st, "reviewer", { at, count: 0 });
  assert.equal(st.allocated, REVIEWER);
});

test("a session that would pass the issue budget by one token is refused", () => {
  const allocated = ISSUE_BUDGET - REVIEWER + 1;
  const st = { allocated, sessions: ["spec"] };
  assert.deepEqual(chargeSession(budgets, st, "reviewer", { at }), {
    charged: false,
    pool: "issue",
    reason: "issue token budget exhausted",
    detail:
      "Allocated 940001 of 1000000 tokens (issueTokenBudget); the next step (reviewer) needs 60000.",
  });
  assert.deepEqual(st, { allocated, sessions: ["spec"] });
});

test("a session that reaches the budget exactly is charged", () => {
  const st = { allocated: ISSUE_BUDGET - REVIEWER };
  assert.deepEqual(chargeSession(budgets, st, "reviewer", { at }), {
    charged: true,
    pool: "issue",
  });
  assert.equal(st.allocated, ISSUE_BUDGET);
});

test("only the latest 40 sessions are kept", () => {
  const sessions = Array.from({ length: KEPT_SESSIONS }, () => "triage");
  const st = { allocated: 0, sessions };
  chargeSession(budgets, st, "fixer", { at });
  assert.equal(st.sessions.length, KEPT_SESSIONS);
  assert.equal(st.sessions.at(-1), "fixer");
  assert.equal(st.sessions.at(0), "triage");
});

test("a rebase-pool charge adds only to the rebase allowance and logs it", () => {
  const st = { allocated: NEAR_FULL, rebaseAllocated: 0 };
  assert.deepEqual(
    chargeSession(budgets, st, "fixer", { at, pool: "rebase" }),
    { charged: true, pool: "rebase" },
  );
  assert.equal(st.allocated, NEAR_FULL);
  assert.equal(st.rebaseAllocated, FIXER);
  assert.deepEqual(st.log, [
    "2026-10-15T12:00Z charged fixer 100000 to rebaseTokenBudget",
  ]);
});

test("a state saved without a rebase allowance reads it as 0", () => {
  const st = { allocated: 0 };
  chargeSession(budgets, st, "fixer", { at, pool: "rebase" });
  assert.equal(st.rebaseAllocated, FIXER);
});

test("a re-check charges the rebase pool when no pool is named", () => {
  const rechecking = { allocated: 0, rebaseAllocated: 0, rechecking: true };
  assert.equal(
    chargeSession(budgets, rechecking, "reviewer", { at }).pool,
    "rebase",
  );
  assert.equal(rechecking.rebaseAllocated, REVIEWER);
  assert.equal(rechecking.allocated, 0);

  const firstPass = { allocated: 0, rebaseAllocated: 0, rechecking: false };
  assert.equal(
    chargeSession(budgets, firstPass, "reviewer", { at }).pool,
    "issue",
  );
  assert.equal(firstPass.allocated, REVIEWER);
  assert.equal(firstPass.rebaseAllocated, 0);
});

test("a refused rebase-pool charge names the rebase allowance and leaves the state alone", () => {
  const st = { allocated: 0, rebaseAllocated: 450_000, sessions: ["spec"] };
  assert.deepEqual(
    chargeSession(budgets, st, "fixer", { at, pool: "rebase" }),
    {
      charged: false,
      pool: "rebase",
      reason: "rebase token budget exhausted",
      detail:
        "Allocated 450000 of 500000 rebase tokens (rebaseTokenBudget); the next step (fixer) needs 100000.",
    },
  );
  assert.deepEqual(st, {
    allocated: 0,
    rebaseAllocated: 450_000,
    sessions: ["spec"],
  });
});

test("checking a charge never changes the state", () => {
  const st = { allocated: 0, rebaseAllocated: 0, sessions: ["spec"] };
  assert.deepEqual(chargeCheck(budgets, st, "fixer", "rebase"), {
    charged: true,
    pool: "rebase",
  });
  assert.deepEqual(chargeCheck(budgets, st, "fixer", "issue"), {
    charged: true,
    pool: "issue",
  });
  assert.deepEqual(st, {
    allocated: 0,
    rebaseAllocated: 0,
    sessions: ["spec"],
  });

  const full = { allocated: ISSUE_BUDGET, rebaseAllocated: REBASE_BUDGET };
  assert.equal(chargeCheck(budgets, full, "fixer", "rebase").charged, false);
  assert.deepEqual(full, {
    allocated: ISSUE_BUDGET,
    rebaseAllocated: REBASE_BUDGET,
  });
});
