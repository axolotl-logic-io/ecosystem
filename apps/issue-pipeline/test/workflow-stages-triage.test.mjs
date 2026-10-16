// @ts-check
// The built workflow's triage paths, run through workflow-harness.mjs. Each
// test pins the summary and the ops requests and saved state the triage
// decision goes through, read through stage-outcome-test-kit.mjs.
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

/** @import { Scripted } from "./workflow-harness.mjs" */

// The plan triage gives a ready issue.
const PLAN = "Change src/a.ts and test it.";

// The triage reply, with `fields` replacing the empty decision's.
/** @param {object} fields @returns {object} */
function triageReply(fields) {
  return replyWith({
    decision: "ready",
    reason: "",
    questions: [],
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

test("a ready issue gets a draft PR and is held at spec by the spawn cap", async () => {
  // spec needs 3 spawns: 5 launched + 3 + a reserve of 4 passes 11.
  const { trace, summary } = await triageRun(
    triageReply({
      reason: "Small and clear.",
      plan: PLAN,
    }),
    { "start-pr": { ok: true, pr: 42, headSha: "aaaaaaa" } },
    { maxSpawnsPerRun: 12 },
  );
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  const { plan } = requestFor(trace, "start-pr");
  assert.equal(plan, PLAN);
  const state = releasedState(trace);
  assert.deepEqual(
    { stage: state.stage, pr: state.pr, plan: state.plan },
    { stage: "spec", pr: 42, plan: PLAN },
  );
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
});

test("a rejected issue is stopped with the reason", async () => {
  const { trace, summary } = await triageRun(
    triageReply({ decision: "reject", reason: "A design debate." }),
  );
  const { code, reason, detail } = requestFor(trace, "stop");
  assert.deepEqual(
    [code, reason, detail],
    [
      null,
      "triage rejected the issue for the agent pipeline",
      "A design debate.",
    ],
  );
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
});

test("a large issue at depth 0 goes on to the spec with no sub-issues", async () => {
  // With no draft PR to open, the run spawns one fewer than the ready issue's,
  // so a cap one lower holds it at spec.
  const { trace, summary } = await triageRun(
    triageReply({ decision: "split", reason: "Too big.", plan: PLAN }),
    {},
    { maxSpawnsPerRun: 11 },
  );
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-reader"]);
  assert.throws(() => requestFor(trace, "split"));
  assert.throws(() => requestFor(trace, "start-pr"));
  const state = releasedState(trace);
  assert.deepEqual(
    {
      stage: state.stage,
      splitSuggested: state.splitSuggested,
      plan: state.plan,
    },
    { stage: "spec", splitSuggested: "Too big.", plan: PLAN },
  );
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: null,
          stage: "spec",
          outcome: "in-progress",
          reason: null,
          allocatedTokens: 50_000,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
});
