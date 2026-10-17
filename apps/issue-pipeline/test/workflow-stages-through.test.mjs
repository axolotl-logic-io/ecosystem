// @ts-check
// The built workflow with args.through, run through workflow-harness.mjs: the
// sweep begins no stage after the named one and releases the issue at its next
// stage.
import assert from "node:assert/strict";
import { test } from "node:test";
import { releasedState, sessionAgents } from "./stage-outcome-test-kit.mjs";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  ISSUE,
  ROUTINE_OPS,
  replyWith,
  sweepReply,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */

// Issue #7 after triage: its plan and draft PR.
const TRIAGED = {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
};

const SPEC_READY = replyWith({
  decision: "ready",
  spec: "## Behaviour\n\n1. src/a.ts does the thing.\n\n<!-- end of spec -->",
  questions: [],
  subIssues: [],
});

// The error a run with an unknown args.through fails with.
const UNKNOWN_STAGE = /args\.through must be one of: triage, spec, implement/u;

test("through spec: the spec is written, then the issue is released at implement", async () => {
  const { trace, summary } = await runWorkflow({
    args: { ...WORKFLOW_ARGS, through: "spec" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("spec", TRIAGED),
    },
    agents: { "i7-spec": SPEC_READY },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-specifier"]);
  const released = releasedState(trace);
  assert.equal(released.stage, "implement");
  assert.equal(released.spec, "## Behaviour\n\n1. src/a.ts does the thing.");
  assert.deepEqual(
    /** @type {SweepSummary} */ (summary).items.map(({ stage, outcome }) => ({
      stage,
      outcome,
    })),
    [{ stage: "implement", outcome: "in-progress" }],
  );
});

test("through spec: an issue already at review begins no stage and is released", async () => {
  const { trace, summary } = await runWorkflow({
    args: { ...WORKFLOW_ARGS, through: "spec" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("review", { ...TRIAGED, implemented: true }),
    },
    agents: {},
  });
  assert.deepEqual(sessionAgents(trace), []);
  assert.equal(releasedState(trace).stage, "review");
  const [item] = /** @type {SweepSummary} */ (summary).items;
  assert.equal(item?.stage, "review");
});

test("through names an unknown stage: the run fails before the sweep", async () => {
  await assert.rejects(
    runWorkflow({
      args: { ...WORKFLOW_ARGS, through: "deploy" },
      ops: ROUTINE_OPS,
      agents: {},
    }),
    UNKNOWN_STAGE,
  );
});
