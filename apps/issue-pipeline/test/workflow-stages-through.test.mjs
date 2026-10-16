// @ts-check
// The built workflow with args.through, run through workflow-harness.mjs: the
// sweep begins no stage after the named one and releases the issue at its next
// stage.
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
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */
/** @import { IssueState } from "../src/workflow/types.ts" */
/** @import { TraceEntry } from "./workflow-harness.mjs" */

// Issue #7 after triage: its plan and draft PR.
const TRIAGED = {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
  allocated: 50_000,
};

const SPEC_READY = replyWith({
  decision: "ready",
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  questions: [],
  files: ["src/a.ts"],
});

// The error a run with an unknown args.through fails with.
const UNKNOWN_STAGE = /args\.through must be one of: triage, spec, implement/u;

// The state the run's first release request carried.
/** @param {readonly TraceEntry[]} trace @returns {IssueState} */
function releasedState(trace) {
  for (const { request } of trace) {
    const { op, state } = /** @type {{ op: string, state: IssueState }} */ (
      request ?? {}
    );
    if (op === "release") {
      return state;
    }
  }
  throw new Error("the sweep released no issue");
}

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
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-save-3",
    "i7-spec-4",
    "i7-release-5",
    "cleanup-6",
  ]);
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
  const { trace } = await runWorkflow({
    args: { ...WORKFLOW_ARGS, through: "spec" },
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt("review", { ...TRIAGED, implemented: true }),
    },
    agents: {},
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-release-3",
    "cleanup-4",
  ]);
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
