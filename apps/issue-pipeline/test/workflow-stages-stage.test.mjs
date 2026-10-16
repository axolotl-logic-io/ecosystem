// The built workflow with args.stage, run through workflow-harness.mjs: the
// sweep begins only the named stage, releases the issue wherever that stage
// leaves it, and releases an issue saved at another stage untouched.
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

// Issue #7 after triage: its plan and draft PR.
/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */

const TRIAGED = {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
  allocated: 50_000,
};

const SPEC_READY = replyWith({
  decision: "ready",
  spec: "## Behaviour\n\n1. src/a.ts does the thing.\n\n<!-- end of spec -->",
  questions: [],
  files: ["src/a.ts"],
});

// The error a run with an unknown args.stage fails with.
const UNKNOWN_STAGE = /args\.stage must be one of: triage, spec, implement/u;
const NAMES_TRIAGE = /triage/u;
const NAMES_SPEC = /spec/u;

test("stage spec: the spec is written, then the issue is released at implement", async () => {
  const { trace, summary } = await runWorkflow({
    args: { ...WORKFLOW_ARGS, stage: "spec" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("spec", TRIAGED),
    },
    agents: { "i7-spec": SPEC_READY },
  });
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-specifier"]);
  assert.equal(releasedState(trace).stage, "implement");
  assert.deepEqual(
    /** @type {SweepSummary} */ (summary).items.map(({ stage, outcome }) => ({
      stage,
      outcome,
    })),
    [{ stage: "implement", outcome: "in-progress" }],
  );
});

test("stage spec: an issue saved at triage begins no stage and is released as wrong-stage", async () => {
  const { trace, summary } = await runWorkflow({
    args: { ...WORKFLOW_ARGS, stage: "spec" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("triage"),
    },
    agents: {},
  });
  assert.deepEqual(sessionAgents(trace), []);
  assert.equal(releasedState(trace).stage, "triage");
  const [item] = /** @type {SweepSummary} */ (summary).items;
  assert.equal(item?.outcome, "wrong-stage");
  const reason = item?.reason ?? "";
  assert.match(reason, NAMES_TRIAGE);
  assert.match(reason, NAMES_SPEC);
});

test("stage names an unknown stage: the run fails before the sweep", async () => {
  await assert.rejects(
    runWorkflow({
      args: { ...WORKFLOW_ARGS, stage: "deploy" },
      ops: ROUTINE_OPS,
      agents: {},
    }),
    UNKNOWN_STAGE,
  );
});
