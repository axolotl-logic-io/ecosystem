// @ts-check
// The built workflow's review and fix-round paths, run through
// workflow-harness.mjs. Each test pins the summary, the sessions that ran, and
// the stop request or the state saved at release, read through
// stage-outcome-test-kit.mjs.
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

const READER = "issue-pipeline-reader";

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
/**
 * @param {object} run
 * @param {object} run.claim
 * @param {Record<string, Scripted>} [run.ops]
 * @param {Record<string, Scripted>} [run.agents]
 * @param {object} [run.config]
 * @returns {ReturnType<typeof runWorkflow>}
 */
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
        ...fields,
      },
    ],
  });
}

test("a review with no blocking findings moves to checks, held by the spawn cap", async () => {
  // The save after open-pr runs for an issue already at review. checks needs
  // 13 spawns: 8 launched + 13 + a reserve of 5 is 26, past 15.
  const { trace, summary } = await reviewRun({
    claim: claimAt("review", OPENED),
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
  assert.deepEqual(sessionAgents(trace), [READER, READER, READER]);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.reviewedSha], ["checks", "bbbbbbb"]);
  assert.deepEqual(summary, issueSummary({}));
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
    status: "done",
    fixed: ["f1"],
    disputed: [],
    summary: "Fixed the loop bound.",
  }),
  "i7-rereview-correctness-r1": replyWith({
    results: [{ id: "f1", status: "resolved", note: "Bound fixed." }],
    newFindings: [],
  }),
};

test("a blocking finding is fixed and re-reviewed clean, then held at checks without a rebase", async () => {
  // checks needs 13 spawns: 14 launched + 13 + a reserve of 5 is 32, past 29.
  const { trace, summary } = await reviewRun({
    claim: claimAt("review", OPENED),
    ops: {
      "prepare-review": { ok: true, headSha: "bbbbbbb" },
      push: { ok: true, headSha: "ccccccc" },
    },
    agents: FIX_AGENTS,
    config: { maxSpawnsPerRun: 29 },
  });
  // A writer fixed the finding, its fix was pushed, and a reader re-reviewed it.
  const agents = sessionAgents(trace);
  assert.ok(agents.includes("issue-pipeline-writer"));
  assert.ok(agents.includes(READER));
  const { number } = requestFor(trace, "push");
  assert.equal(number, ISSUE);
  // A cleared re-review goes to checks on the branch as it stands (#340).
  assert.throws(() => requestFor(trace, "sync-base"));
  const state = releasedState(trace);
  assert.deepEqual(
    [state.stage, state.findings?.map(({ status }) => status)],
    ["checks", ["resolved"]],
  );
  assert.deepEqual(summary, issueSummary({ stage: "checks" }));
});

test("a finding still open after the last fix round stops the issue", async () => {
  const { trace, summary } = await reviewRun({
    claim: claimAt("fix", {
      ...OPENED,
      reviewedSha: "bbbbbbb",
      round: 2,
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
  assert.deepEqual(sessionAgents(trace), []);
  const { code, reason } = requestFor(trace, "stop");
  assert.deepEqual(
    [code, reason],
    [null, "blocking findings remain after 2 fix rounds"],
  );
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "fix",
      outcome: "stopped",
      reason: "blocking findings remain after 2 fix rounds",
    }),
  );
});
