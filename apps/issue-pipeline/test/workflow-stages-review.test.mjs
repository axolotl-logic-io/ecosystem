// The built workflow's review and fix-round paths, run through
// workflow-harness.mjs. Each test pins the launch keys and the summary by hand,
// and the whole trace in workflow-stages-review.test.mjs.snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
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

// Issue #7 with its PR open for review.
const OPENED = { pr: 42, headSha: "bbbbbbb", implemented: true };
const NO_FINDINGS = replyWith({ findings: [] });
const OFF_BY_ONE = {
  file: "src/a.ts",
  line: 3,
  title: "Off by one",
  evidence: "The loop stops one item early.",
  suggestion: "Use <= in the loop bound.",
};

// A run of issue #7 claimed with `claim`, with the given ops and agents.
function reviewRun({ claim, ops = {}, agents = {}, config = {} }) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config }),
      claim,
      ...ops,
    },
    agents,
  });
}

// The one summary item of issue #7, with `fields` replacing the defaults.
function issueSummary(fields) {
  return sweepSummary({
    items: [
      {
        issue: 7,
        pr: 42,
        stage: "sync",
        outcome: "in-progress",
        reason: null,
        allocatedTokens: 0,
        ...fields,
      },
    ],
  });
}

test("a review with no blocking findings moves to sync, held by the spawn cap", async ({
  assert: { snapshot },
}) => {
  // The save after open-pr runs for an issue already at review. sync needs 3
  // spawns: 8 launched + 3 + a reserve of 4 passes 14.
  const { trace, summary } = await reviewRun({
    claim: claimAt("review", { ...OPENED, allocated: 280_000 }),
    ops: { "prepare-review": { ok: true, headSha: "bbbbbbb" } },
    agents: {
      "i7-review-correctness": NO_FINDINGS,
      "i7-review-tests": replyWith({
        findings: [{ severity: "nit", ...OFF_BY_ONE, title: "Name it" }],
      }),
      "i7-review-scope": NO_FINDINGS,
    },
    config: { maxSpawnsPerRun: 15 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-save-3",
    "i7-prep-4",
    "i7-review-correctness-5",
    "i7-review-tests-6",
    "i7-review-scope-7",
    "i7-save-8",
    "i7-release-9",
    "cleanup-10",
  ]);
  assert.deepEqual(summary, issueSummary({ allocatedTokens: 460_000 }));
  snapshot(trace);
});

// One blocking finding, aggregated, fixed and resolved on re-review.
const FIX_AGENTS = {
  "i7-review-correctness": replyWith({
    findings: [{ severity: "blocking", ...OFF_BY_ONE }],
  }),
  "i7-review-tests": NO_FINDINGS,
  "i7-review-scope": NO_FINDINGS,
  "i7-aggregate": replyWith({
    blocking: [{ ...OFF_BY_ONE, lenses: ["correctness"] }],
  }),
  "i7-fix-r1": replyWith({
    fixed: ["f1"],
    disputed: [],
    summary: "Fixed the loop bound.",
  }),
  "i7-rereview-correctness-r1": replyWith({
    results: [{ id: "f1", status: "resolved", note: "Bound fixed." }],
    newFindings: [],
  }),
};

test("a blocking finding is fixed and re-reviewed clean, then synced and held at checks", async ({
  assert: { snapshot },
}) => {
  // sync runs at the spawn count fix needed, so the hold comes at checks:
  // 15 launched + 11 + a reserve of 4 passes 28.
  const { trace, summary } = await reviewRun({
    claim: claimAt("review", { ...OPENED, allocated: 280_000 }),
    ops: {
      "prepare-review": { ok: true, headSha: "bbbbbbb" },
      push: { ok: true, headSha: "ccccccc" },
      "sync-base": { ok: true, conflict: false, headSha: "ccccccc" },
    },
    agents: FIX_AGENTS,
    config: { maxSpawnsPerRun: 29 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-save-3",
    "i7-prep-4",
    "i7-review-correctness-5",
    "i7-review-tests-6",
    "i7-review-scope-7",
    "i7-aggregate-8",
    "i7-save-9",
    "i7-fix-r1-10",
    "i7-push-11",
    "i7-prep-12",
    "i7-rereview-correctness-r1-13",
    "i7-save-14",
    "i7-sync-15",
    "i7-release-16",
    "cleanup-17",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({ stage: "checks", allocatedTokens: 620_000 }),
  );
  snapshot(trace);
});

test("a finding still open after the last fix round stops the issue", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await reviewRun({
    claim: claimAt("fix", {
      ...OPENED,
      reviewedSha: "bbbbbbb",
      round: 2,
      allocated: 620_000,
      nextFindingId: 1,
      findings: [
        {
          id: "f1",
          ...OFF_BY_ONE,
          lenses: ["correctness"],
          category: null,
          status: "open",
          disputed: false,
        },
      ],
    }),
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-stop-3",
    "cleanup-4",
  ]);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "fix",
      outcome: "stopped",
      reason: "blocking findings remain after 2 fix rounds",
      allocatedTokens: 620_000,
    }),
  );
  snapshot(trace);
});
