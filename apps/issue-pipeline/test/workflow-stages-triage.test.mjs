// @ts-check
// The built workflow's triage paths, run through workflow-harness.mjs. Each
// test pins the launch keys and the summary by hand, and the whole trace in
// workflow-stages-triage.test.mjs.snapshot.
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

/** @import { Scripted } from "./workflow-harness.mjs" */

// The triage reply, with `fields` replacing the empty decision's.
/** @param {object} fields @returns {object} */
function triageReply(fields) {
  return replyWith({
    decision: "ready",
    reason: "",
    questions: [],
    subIssues: [],
    plan: "",
    ...fields,
  });
}

// A run of issue #7 at triage, with the triage agent's reply and extra ops.
/**
 * @param {Scripted} triage
 * @param {Record<string, Scripted>} [ops]
 * @param {object} [config]
 * @returns {ReturnType<typeof runWorkflow>}
 */
function triageRun(triage, ops = {}, config = {}) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config }),
      claim: claimAt("triage"),
      ...ops,
    },
    agents: { "i7-triage": triage },
  });
}

test("a ready issue gets a draft PR and is held at spec by the spawn cap", async ({
  assert: { snapshot },
}) => {
  // spec needs 3 spawns: 5 launched + 3 + a reserve of 4 passes 11.
  const { trace, summary } = await triageRun(
    triageReply({
      reason: "Small and clear.",
      plan: "Change src/a.ts and test it.",
    }),
    { "start-pr": { ok: true, pr: 42, headSha: "aaaaaaa" } },
    { maxSpawnsPerRun: 12 },
  );
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-triage-3",
    "i7-startpr-4",
    "i7-save-5",
    "i7-release-6",
    "cleanup-7",
  ]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: 42,
          stage: "spec",
          outcome: "in-progress",
          reason: null,
          allocatedTokens: 50_000,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
  snapshot(trace);
});

test("a rejected issue is stopped with the reason", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await triageRun(
    triageReply({ decision: "reject", reason: "A design debate." }),
  );
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-triage-3",
    "i7-stop-4",
    "cleanup-5",
  ]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: null,
          stage: "triage",
          outcome: "stopped",
          reason: "triage rejected the issue for the agent pipeline",
          allocatedTokens: 50_000,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
  snapshot(trace);
});

test("a large issue at depth 0 is split into its sub-issues", async ({
  assert: { snapshot },
}) => {
  const subIssues = [
    { title: "First part", body: "Do the first part.", after: [] },
    { title: "Second part", body: "Do the second part.", after: [0] },
  ];
  const { trace, summary } = await triageRun(
    triageReply({ decision: "split", reason: "Too big.", subIssues }),
    { split: { ok: true } },
  );
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-triage-3",
    "i7-split-4",
    "cleanup-5",
  ]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: null,
          stage: "triage",
          outcome: "split",
          reason: null,
          allocatedTokens: 50_000,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
  snapshot(trace);
});
