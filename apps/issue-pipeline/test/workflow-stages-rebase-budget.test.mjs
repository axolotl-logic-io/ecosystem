// The rebase pool (`rebaseTokenBudget`) through the built workflow, run with
// workflow-harness.mjs: conflict resolvers, and the re-checks after a rebase
// the merge stage asked for, are charged to it rather than to the issue's
// budget. Each test pins the launch keys and the summary by hand, and the
// whole trace in workflow-stages-rebase-budget.test.mjs.snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ISSUE,
  launchKeys,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

const NEAR_ISSUE_BUDGET = 980_000;
const RESOLVER = 100_000;
const VERIFIER = 60_000;
const REVIEWER = 60_000;
// Issue #7, 20k short of its 1M issue budget, sent back by the merge stage
// after passing every check at ccccccc.
const SENT_BACK = {
  pr: 42,
  headSha: "ccccccc",
  reviewedSha: "ccccccc",
  verifiedSha: "ccccccc",
  passedSha: "ccccccc",
  implemented: true,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  allocated: NEAR_ISSUE_BUDGET,
};
// The same issue rebased onto fffffff, its checks passed again.
const RECHECKED = {
  ...SENT_BACK,
  headSha: "fffffff",
  verifiedSha: "fffffff",
  passedSha: null,
  verifySummary: "test: passed",
  rechecking: true,
  rebaseAllocated: RESOLVER,
  conflictFixes: 1,
};
const PREPARED = { "prepare-review": { ok: true, headSha: "fffffff" } };
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
};

/** @import { FinishRun } from "./workflow-finish-run-kit.mjs" */
/** @import { TraceEntry } from "./workflow-harness.mjs" */
/** @typedef {{ op?: string, keepConflict?: boolean, reason?: string, detail?: string }} TracedRequest */

// A run of issue #7 claimed at `stage` with `fields`, with ops and agents.
/** @param {FinishRun} run @returns {Promise<{ trace: TraceEntry[], summary: unknown }>} */
function rebaseRun({ stage, fields, ops = {}, agents = {}, config = {} }) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config }),
      claim: claimAt(stage, fields),
      ...ops,
    },
    agents,
  });
}

// The one summary item of issue #7, with `fields` replacing the defaults.
/** @param {object} fields @returns {object} */
function issueSummary(fields) {
  return sweepSummary({
    items: [
      {
        issue: 7,
        pr: 42,
        outcome: "in-progress",
        reason: null,
        allocatedTokens: NEAR_ISSUE_BUDGET,
        ...fields,
      },
    ],
  });
}

// The ops requests of the run's launches, {} for a session.
/** @param {readonly TraceEntry[]} trace @returns {TracedRequest[]} */
function requestsOf(trace) {
  return trace.map(
    (entry) => /** @type {TracedRequest} */ (entry.request ?? {}),
  );
}

// The request of the run's stop launch.
/** @param {readonly TraceEntry[]} trace @returns {TracedRequest} */
function stopRequest(trace) {
  return requestsOf(trace).find(({ op }) => op === "stop") ?? {};
}

test("an issue near its budget still gets the resolver after a merge sent it back", async ({
  assert: { snapshot },
}) => {
  // checks needs 11 spawns: 5 launched + 11 + a reserve of 4 passes 19.
  const { trace, summary } = await rebaseRun({
    stage: "sync",
    fields: SENT_BACK,
    ops: {
      "sync-base": CONFLICT,
      "finish-sync": { ok: true, resolved: true, headSha: "fffffff" },
    },
    agents: {
      "i7-conflicts-1": replyWith({
        status: "fixed",
        summary: "Kept both changes to src/a.ts.",
      }),
    },
    config: { maxSpawnsPerRun: 19 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-sync-3",
    "i7-conflicts-1-4",
    "i7-finish-sync-5",
    "i7-release-6",
    "cleanup-7",
  ]);
  assert.equal(requestsOf(trace)[2]?.keepConflict, true);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "checks", rebaseAllocatedTokens: RESOLVER }),
  );
  snapshot(trace);
});

test("a re-check's verifier and security reviewer are charged to the rebase pool", async ({
  assert: { snapshot },
}) => {
  // security needs 3 spawns: 4 launched + 3 + a reserve of 4 fits 12; merge
  // then needs 2: 7 launched + 2 + a reserve of 4 passes 12.
  const { trace, summary } = await rebaseRun({
    stage: "accept",
    fields: RECHECKED,
    ops: PREPARED,
    agents: {
      "i7-accept": replyWith({ verdict: "pass", reason: "Does it." }),
      "i7-security": replyWith({ findings: [] }),
    },
    config: { maxSpawnsPerRun: 12 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-accept-4",
    "i7-prep-5",
    "i7-security-6",
    "i7-save-7",
    "i7-release-8",
    "cleanup-9",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "merge",
      rebaseAllocatedTokens: RESOLVER + VERIFIER + REVIEWER,
    }),
  );
  snapshot(trace);
});

test("a re-check stops when the rebase allowance runs out", async ({
  assert: { snapshot },
}) => {
  const spent = { ...RECHECKED, rebaseAllocated: 460_000 };
  const { trace, summary } = await rebaseRun({
    stage: "accept",
    fields: spent,
    ops: PREPARED,
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-stop-4",
    "cleanup-5",
  ]);
  const { reason, detail } = stopRequest(trace);
  assert.equal(reason, "rebase token budget exhausted");
  assert.equal(
    detail,
    "Allocated 460000 of 500000 rebase tokens (rebaseTokenBudget); the next step (verifier) needs 60000.",
  );
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "accept",
      outcome: "stopped",
      reason,
      rebaseAllocatedTokens: spent.rebaseAllocated,
    }),
  );
  snapshot(trace);
});

test("a conflict the rebase pool can't pay a resolver for is a budget stop", async ({
  assert: { snapshot },
}) => {
  const spent = { ...SENT_BACK, rebaseAllocated: 450_000, conflictFixes: 0 };
  const { trace, summary } = await rebaseRun({
    stage: "sync",
    fields: spent,
    ops: { "sync-base": { ...CONFLICT, inRebase: false } },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-sync-3",
    "i7-stop-4",
    "cleanup-5",
  ]);
  assert.equal(requestsOf(trace)[2]?.keepConflict, false);
  const { reason, detail } = stopRequest(trace);
  assert.equal(reason, "rebase token budget exhausted");
  assert.equal(stopFor(reason)?.code, "budget");
  assert.equal(
    detail,
    "Allocated 450000 of 500000 rebase tokens (rebaseTokenBudget); the next step (fixer) needs 100000.\n\nConflicting files:\nsrc/a.ts",
  );
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "sync",
      outcome: "stopped",
      reason,
      rebaseAllocatedTokens: spent.rebaseAllocated,
    }),
  );
  snapshot(trace);
});
