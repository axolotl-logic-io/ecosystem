// @ts-check
// A session of sync, checks, accept or security that fails on a model
// provider's rate limit or overload defers its issue the way a network error
// does (`rate-limit-defers`), run through workflow-harness.mjs: the issue is
// released with its work and the attempt counts it had as the stage began,
// with no stop, no further stage this sweep, and the outcome `rate-limited`
// in the summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COOLING_DOWN,
  issueRun,
  itemOf,
  OVERLOADED,
  opsOf,
} from "./rate-limit-test-kit.mjs";
import { releasedState } from "./stage-outcome-test-kit.mjs";
import { claimAt, replyWith } from "./workflow-stages-fixtures.mjs";

const NO_FINDINGS = replyWith({ findings: [] });

// Issue #7 claimed at sync with a reviewed head.
const AT_SYNC = claimAt("sync", {
  pr: 42,
  headSha: "bbbbbbb",
  reviewedSha: "bbbbbbb",
});
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
};
const ABORTED = { ok: true, resolved: false, reason: "aborted" };

test("a conflict resolver that hits an overload aborts the rebase and leaves the issue at sync with no attempt counted", async () => {
  const { trace, summary } = await issueRun(
    AT_SYNC,
    { "i7-conflicts-1": OVERLOADED },
    { "sync-base": CONFLICT, "finish-sync": ABORTED },
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  assert.ok(opsOf(trace).includes("finish-sync"));
  const state = releasedState(trace);
  assert.deepEqual(
    [state.stage, state.conflictFixes ?? 0, state.headSha],
    ["sync", 0, "bbbbbbb"],
  );
  assert.deepEqual(itemOf(summary), { stage: "sync", outcome: "rate-limited" });
});

// Issue #7 rebased onto ddddddd after its review, at checks, and the checks
// failing on it.
const AT_CHECKS = claimAt("checks", {
  pr: 42,
  headSha: "ddddddd",
  reviewedSha: "ccccccc",
  implemented: true,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
});
const CHECKS_FAIL = {
  verify: {
    ok: true,
    headSha: "ddddddd",
    pass: false,
    checks: [
      {
        id: "test",
        pass: false,
        detail: "1 failed",
        log: "/w/runs/o__r/issue-7/test.log",
        tail: "expected 3, got 2",
      },
    ],
  },
  push: { ok: true, headSha: "fffffff" },
  "prepare-review": { ok: true, headSha: "fffffff" },
};

test("a CI fixer that hits the rate limit leaves the issue at checks with no CI fix counted", async () => {
  const { trace, summary } = await issueRun(
    AT_CHECKS,
    { "i7-cifix-1": COOLING_DOWN },
    CHECKS_FAIL,
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.ciFixes], ["checks", 0]);
  assert.deepEqual(itemOf(summary), {
    stage: "checks",
    outcome: "rate-limited",
  });
});

test("a check-fix reviewer that hits the rate limit sends the pushed fix to review, its CI fix counted", async () => {
  const { trace, summary } = await issueRun(
    AT_CHECKS,
    {
      "i7-cifix-1": replyWith({ status: "fixed", summary: "Fixed the test." }),
      "i7-cifix-review-correctness-1": COOLING_DOWN,
      "i7-cifix-review-scope-1": NO_FINDINGS,
    },
    CHECKS_FAIL,
  );
  assert.equal(opsOf(trace).includes("stop"), false);
  const state = releasedState(trace);
  assert.deepEqual(
    [state.stage, state.headSha, state.ciFixes],
    ["review", "fffffff", 1],
  );
  assert.deepEqual(itemOf(summary), {
    stage: "review",
    outcome: "rate-limited",
  });
});

// Issue #7 verified at its head, at accept or security.
/** @param {string} stage @returns {object} */
function verifiedAt(stage) {
  return claimAt(stage, {
    pr: 42,
    headSha: "ddddddd",
    reviewedSha: "ddddddd",
    verifiedSha: "ddddddd",
    passedSha: "ddddddd",
    implemented: true,
    spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  });
}
const FINAL_DIFF = {
  "prepare-review": {
    ok: true,
    headSha: "ddddddd",
    diffPath: "/w/runs/o__r/issue-7/final.diff",
    diffLines: "120",
  },
};

for (const stage of ["accept", "security"]) {
  test(`the ${stage} reader that hits the rate limit leaves the issue at ${stage} with no stop`, async () => {
    const { trace, summary } = await issueRun(
      verifiedAt(stage),
      { [`i7-${stage}`]: OVERLOADED },
      FINAL_DIFF,
    );
    assert.equal(opsOf(trace).includes("stop"), false);
    assert.equal(releasedState(trace).stage, stage);
    assert.deepEqual(itemOf(summary), { stage, outcome: "rate-limited" });
  });
}
