// @ts-check
// The built workflow's spec, implement and open-pr stages, run through
// workflow-harness.mjs. The test pins the summary, the sessions that ran, the
// PR opened and the state saved at release, read through
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

// Issue #7 after triage: its plan and draft PR.
const TRIAGED = {
  plan: "Change src/a.ts and test it.",
  pr: 42,
  headSha: "aaaaaaa",
  implemented: false,
  allocated: 50_000,
};

// The spec writer and the implementer, each done.
const BUILD_AGENTS = {
  "i7-spec": replyWith({
    decision: "ready",
    spec: "## Behaviour\n\n1. src/a.ts does the thing.\n\n<!-- end of spec -->",
    questions: [],
    files: ["src/a.ts"],
  }),
  "i7-implement": replyWith({
    status: "done",
    summary: "Did the thing.",
    prTitle: "Do the thing",
    prBody: "Does the thing, tested in src/a.test.ts.",
    testsAdded: ["src/a.test.ts"],
  }),
};

test("a spec is written, implemented and its PR opened, then held at review", async () => {
  // The save after triage runs for an issue already at spec. review needs 7
  // spawns: 8 launched + 7 + a reserve of 4 passes 18.
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config: { maxSpawnsPerRun: 19 } }),
      claim: claimAt("spec", TRIAGED),
      "open-pr": { ok: true, pr: 42, headSha: "bbbbbbb" },
    },
    agents: BUILD_AGENTS,
  });
  assert.deepEqual(sessionAgents(trace), [
    "issue-pipeline-specifier",
    "issue-pipeline-writer",
  ]);
  const { number, title, body } = requestFor(trace, "open-pr");
  assert.deepEqual(
    [number, title, body],
    [ISSUE, "Do the thing", "Does the thing, tested in src/a.test.ts."],
  );
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.implemented], ["review", true]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: 42,
          stage: "review",
          outcome: "in-progress",
          reason: null,
          allocatedTokens: 280_000,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
});
