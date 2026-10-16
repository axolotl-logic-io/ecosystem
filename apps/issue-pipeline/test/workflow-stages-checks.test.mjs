// @ts-check
// The built workflow's sync and checks paths, run through workflow-harness.mjs.
// Each test pins the summary, the sessions that ran, and the stop request or
// the state saved at release, read through stage-outcome-test-kit.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  releasedState,
  requestFor,
  sessionAgents,
} from "./stage-outcome-test-kit.mjs";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { SummaryItem } from "../src/workflow/stages/types.ts" */
/** @import { Scripted } from "./workflow-harness.mjs" */

// Issue #7 with its review passed at ccccccc.
const REVIEWED = {
  pr: 42,
  headSha: "ccccccc",
  reviewedSha: "ccccccc",
  implemented: true,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  allocated: 620_000,
};
// Issue #7 rebased onto ddddddd, at checks.
const SYNCED = { ...REVIEWED, headSha: "ddddddd" };
const NO_FINDINGS = replyWith({ findings: [] });
const FAILED_TEST = {
  id: "test",
  pass: false,
  detail: "1 failed",
  log: "/w/runs/o__r/issue-7/test.log",
  tail: "expected 3, got 2",
};

// A run of issue #7 claimed with `claim`, with the given ops and agents.
/**
 * @param {object} run
 * @param {object} run.claim
 * @param {Record<string, Scripted>} [run.ops]
 * @param {Record<string, Scripted>} [run.agents]
 * @param {object} [run.config]
 * @returns {ReturnType<typeof runWorkflow>}
 */
function checksRun({ claim, ops = {}, agents = {}, config = {} }) {
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
/** @param {Partial<SummaryItem>} fields @returns {object} */
function issueSummary(fields) {
  return sweepSummary({
    items: [
      {
        issue: 7,
        pr: 42,
        stage: "checks",
        outcome: "in-progress",
        reason: null,
        allocatedTokens: 620_000,
        rebaseAllocatedTokens: 0,
        ...fields,
      },
    ],
  });
}

test("a clean rebase moves to checks, held by the spawn cap", async () => {
  // checks needs 11 spawns: 3 launched + 11 + a reserve of 4 passes 17.
  const { trace, summary } = await checksRun({
    claim: claimAt("sync", REVIEWED),
    ops: {
      "sync-base": {
        ok: true,
        conflict: false,
        changed: true,
        headSha: "ddddddd",
      },
    },
    config: { maxSpawnsPerRun: 18 },
  });
  assert.deepEqual(sessionAgents(trace), []);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.headSha], ["checks", "ddddddd"]);
  assert.deepEqual(summary, issueSummary({}));
});

test("a conflicting rebase is resolved by a writer, then held at checks", async () => {
  // checks needs 11 spawns: 5 launched + 11 + a reserve of 4 passes 19.
  const { trace, summary } = await checksRun({
    claim: claimAt("sync", REVIEWED),
    ops: {
      "sync-base": {
        ok: true,
        conflict: true,
        inRebase: true,
        conflicts: ["src/a.ts"],
      },
      "finish-sync": { ok: true, resolved: true, headSha: "ddddddd" },
    },
    agents: {
      "i7-conflicts-1": replyWith({
        status: "fixed",
        summary: "Kept both changes to src/a.ts.",
      }),
    },
    config: { maxSpawnsPerRun: 20 },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-writer"]);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.headSha], ["checks", "ddddddd"]);
  // The resolver is charged to the rebase pool, not the issue budget.
  assert.deepEqual(
    summary,
    issueSummary({ allocatedTokens: 620_000, rebaseAllocatedTokens: 100_000 }),
  );
});

// Verification failing and then passing, and every op after it succeeding.
const CI_FIX_OPS = {
  verify: [
    { ok: true, headSha: "ddddddd", pass: false, checks: [FAILED_TEST] },
    {
      ok: true,
      headSha: "fffffff",
      pass: true,
      checks: [{ id: "test", pass: true, detail: "passed" }],
    },
  ],
  push: { ok: true, headSha: "fffffff" },
  "prepare-review": { ok: true, headSha: "fffffff" },
  "ci-status": { ok: true, status: "pass" },
  merge: { ok: true, merged: true },
};

// The CI fixer and the reviews after it, each passing.
const CI_FIX_AGENTS = {
  "i7-cifix-1": replyWith({ status: "fixed", summary: "Fixed the test." }),
  "i7-cifix-review-correctness-1": NO_FINDINGS,
  "i7-cifix-review-scope-1": NO_FINDINGS,
  "i7-accept": replyWith({ verdict: "pass", reason: "Does what #7 asks." }),
  "i7-security": NO_FINDINGS,
};

test("failing checks get a reviewed CI fix, then pass and go on to merge", async () => {
  // accept needs 2 spawns and checks 11, so no spawn cap holds the issue
  // at accept once its checks fit: the run goes on to merge.
  const { trace, summary } = await checksRun({
    claim: claimAt("checks", SYNCED),
    ops: CI_FIX_OPS,
    agents: CI_FIX_AGENTS,
  });
  // A writer fixed CI, a reader reviewed the fix, and the fix was pushed.
  const agents = sessionAgents(trace);
  assert.ok(agents.includes("issue-pipeline-writer"));
  assert.ok(agents.includes("issue-pipeline-reader"));
  const { number: pushed } = requestFor(trace, "push");
  const { number: merged } = requestFor(trace, "merge");
  assert.deepEqual([pushed, merged], [ISSUE, ISSUE]);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "merge",
      outcome: "merged",
      allocatedTokens: 920_000,
      rebaseAllocatedTokens: 0,
    }),
  );
});

test("CI still failing after the last CI fix stops the issue", async () => {
  const { trace, summary } = await checksRun({
    claim: claimAt("checks", {
      ...SYNCED,
      verifiedSha: "ddddddd",
      ciFixes: 1,
    }),
    ops: {
      "ci-status": {
        ok: true,
        status: "fail",
        failing: ["build"],
        logPath: "/w/runs/o__r/issue-7/ci.log",
      },
    },
  });
  assert.deepEqual(sessionAgents(trace), []);
  const { code, reason } = requestFor(trace, "stop");
  assert.deepEqual(
    [code, reason],
    [null, "checks still fail after 1 CI-fix attempts"],
  );
  assert.deepEqual(
    summary,
    issueSummary({
      outcome: "stopped",
      reason: "checks still fail after 1 CI-fix attempts",
    }),
  );
});
