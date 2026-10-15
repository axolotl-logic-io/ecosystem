// The built workflow's spec, implement and open-pr stages, run through
// workflow-harness.mjs. The test pins the launch keys and the summary by hand,
// and the whole trace in workflow-stages-build.test.mjs.snapshot.
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
    spec: "## Behaviour\n\n1. src/a.ts does the thing.",
    questions: [],
  }),
  "i7-implement": replyWith({
    status: "done",
    summary: "Did the thing.",
    prTitle: "Do the thing",
    prBody: "Does the thing, tested in src/a.test.ts.",
    testsAdded: ["src/a.test.ts"],
  }),
};

test("a spec is written, implemented and its PR opened, then held at review", async ({
  assert: { snapshot },
}) => {
  // The save after triage runs for an issue already at spec. review needs 7
  // spawns: 8 launched + 7 + a reserve of 4 passes 18.
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE], config: { maxSpawnsPerRun: 18 } }),
      claim: claimAt("spec", TRIAGED),
      "open-pr": { ok: true, pr: 42, headSha: "bbbbbbb" },
    },
    agents: BUILD_AGENTS,
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-save-3",
    "i7-spec-4",
    "i7-save-5",
    "i7-implement-6",
    "i7-openpr-7",
    "i7-save-8",
    "i7-release-9",
  ]);
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
        },
      ],
    }),
  );
  snapshot(trace);
});
