// The sweep's driver for the review and fix stages, run through
// workflow-harness.mjs: an issue moved to review in a sweep is reviewed in it,
// and each fix round is held to the per-run spawn cap.
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

const NO_FINDINGS = replyWith({ findings: [] });
const OFF_BY_ONE = {
  file: "src/a.ts",
  line: 3,
  title: "Off by one",
  evidence: "The loop stops one item early.",
  suggestion: "Use <= in the loop bound.",
};
const HELD_AT_FIX =
  "2026-10-15T12:00Z held at fix by the per-run spawn cap; continues next sweep";

function issueRun({ claim, ops, agents, config }) {
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

// The state the run's last ops request before the cleanup carried.
function lastState(trace) {
  return trace.at(-2).request.state;
}

test("an issue claimed at open-pr is opened and reviewed in the same sweep", async () => {
  // review fits: 4 launched + 7 + a reserve of 4 is 15; sync doesn't.
  const { trace, summary } = await issueRun({
    claim: claimAt("open-pr", { prTitle: "T", prBody: "B", prBy: null }),
    ops: {
      "open-pr": { ok: true, pr: 42, headSha: "bbbbbbb" },
      "prepare-review": { ok: true, headSha: "bbbbbbb" },
    },
    agents: {
      "i7-review-correctness": NO_FINDINGS,
      "i7-review-tests": NO_FINDINGS,
      "i7-review-scope": NO_FINDINGS,
    },
    config: { maxSpawnsPerRun: 16 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-openpr-3",
    "i7-save-4",
    "i7-prep-5",
    "i7-review-correctness-6",
    "i7-review-tests-7",
    "i7-review-scope-8",
    "i7-save-9",
    "i7-release-10",
    "cleanup-11",
  ]);
  assert.equal(summary.items[0].stage, "sync");
  assert.equal(lastState(trace).reviewedSha, "bbbbbbb");
});

test("a spawn cap that fits fix round 1 but not round 2 holds the issue at fix", async () => {
  // Round 1 fits: 2 launched + 8 + a reserve of 4 is 14. Round 2 doesn't:
  // 7 launched + 8 + 4 is 19.
  const { trace, summary } = await issueRun({
    claim: claimAt("fix", {
      pr: 42,
      headSha: "bbbbbbb",
      reviewedSha: "bbbbbbb",
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
    ops: {
      push: { ok: true, headSha: "ccccccc" },
      "prepare-review": { ok: true, diffPath: "/runs/r1.diff" },
    },
    agents: {
      "i7-fix-r1": replyWith({ fixed: [], disputed: [], summary: "Tried." }),
      "i7-rereview-correctness-r1": replyWith({
        results: [{ id: "f1", status: "unresolved", note: "" }],
        newFindings: [],
      }),
    },
    config: { maxSpawnsPerRun: 15 },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-fix-r1-3",
    "i7-push-4",
    "i7-prep-5",
    "i7-rereview-correctness-r1-6",
    "i7-save-7",
    "i7-release-8",
    "cleanup-9",
  ]);
  const [item] = summary.items;
  assert.deepEqual(
    [item.stage, item.outcome, item.reason],
    ["fix", "in-progress", null],
  );
  assert.equal(lastState(trace).log.at(-1), HELD_AT_FIX);
});
