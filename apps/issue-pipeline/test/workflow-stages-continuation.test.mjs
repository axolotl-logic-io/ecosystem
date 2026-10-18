// @ts-check
// The built workflow's second implement pass, run through
// workflow-harness.mjs: an implementer that hands off gets up to
// maxContinuations continuations in the same sweep, unless the spawn cap
// holds them. The tests pin the implementer sessions that ran and the
// summary.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stopFor } from "../src/stops.ts";
import { sessionAgents } from "./stage-outcome-test-kit.mjs";
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

/** @import { SweepSummary } from "../src/workflow/stages/types.ts" */

const WRITER = "issue-pipeline-writer";

// An implementer that always runs out of room.
const HANDOFF = replyWith({
  status: "handoff",
  summary: "Half done.",
  prTitle: "",
  prBody: "",
  testsAdded: [],
});

// A run of issue #7 claimed at implement, with its spec written.
function implementRun(config = {}) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config }),
      claim: claimAt("implement", {
        plan: "Change src/a.ts.",
        spec: "## Behaviour\n\n1. src/a.ts does the thing.",
        pr: 42,
        headSha: "aaaaaaa",
      }),
    },
    agents: { "i7-implement": HANDOFF },
  });
}

test("the spawn cap holds the continuation until the next sweep", async () => {
  // A second implement session needs 2 spawns, its session and its push: 4
  // launched + 2 + a reserve of 4 passes 9.
  const { trace, summary } = await implementRun({ maxSpawnsPerRun: 10 });
  assert.deepEqual(sessionAgents(trace), [WRITER]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: 42,
          stage: "implement",
          outcome: "in-progress",
          reason: null,
        },
      ],
    }),
  );
});

test("a continuation runs in the same sweep, and a second handoff stops", async () => {
  const { trace, summary } = await implementRun();
  assert.deepEqual(sessionAgents(trace), [WRITER, WRITER]);
  const [entry] = /** @type {SweepSummary} */ (summary).items;
  assert.equal(entry?.outcome, "stopped");
  assert.equal(stopFor(entry?.reason)?.code, "too-large");
  assert.equal(entry?.stage, "implement");
});

test("the sweep begins implement 1 + maxContinuations times", async () => {
  const maxContinuations = 2;
  const { trace, summary } = await implementRun({ maxContinuations });
  assert.deepEqual(
    sessionAgents(trace),
    Array.from({ length: 1 + maxContinuations }, () => WRITER),
  );
  const [entry] = /** @type {SweepSummary} */ (summary).items;
  assert.equal(entry?.outcome, "stopped");
  assert.equal(stopFor(entry?.reason)?.code, "too-large");
});
