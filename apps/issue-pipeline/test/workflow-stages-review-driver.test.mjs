// @ts-check
// The sweep's driver for the review and fix stages, run through
// workflow-harness.mjs: an issue moved to review in a sweep is reviewed in it,
// and each fix round is held to the per-run spawn cap.
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
/** @import { Scripted } from "./workflow-harness.mjs" */

const NO_FINDINGS = replyWith({ findings: [] });
const READER = "issue-pipeline-reader";
const OFF_BY_ONE = {
  file: "src/a.ts",
  line: 3,
  title: "Off by one",
  evidence: "The loop stops one item early.",
  suggestion: "Use <= in the loop bound.",
};
const HELD_AT_FIX =
  "2026-10-15T12:00Z held at fix by the per-run spawn cap; continues next sweep";

// Issue #7 claimed at fix with one open finding, after its review at
// bbbbbbb.
const OPEN_FINDING_CLAIM = claimAt("fix", {
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
});
// A fix round 1 that fixes nothing, whose re-review finds f1 unresolved.
const UNRESOLVED_ROUND = {
  "i7-fix-r1": replyWith({
    status: "done",
    fixed: [],
    disputed: [],
    summary: "Tried.",
  }),
  "i7-rereview-correctness-r1": replyWith({
    results: [{ id: "f1", status: "unresolved", note: "" }],
    newFindings: [],
  }),
};

// A run of issue #7 claimed with `claim`, with the given ops, agents and
// config.
/**
 * @param {object} run
 * @param {object} run.claim
 * @param {Record<string, Scripted>} run.ops
 * @param {Record<string, Scripted>} run.agents
 * @param {object} run.config
 * @returns {ReturnType<typeof runWorkflow>}
 */
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
  assert.deepEqual(sessionAgents(trace), [READER, READER, READER]);
  const [item] = /** @type {SweepSummary} */ (summary).items;
  assert.equal(item?.stage, "sync");
  assert.equal(releasedState(trace).reviewedSha, "bbbbbbb");
});

test("a spawn cap that fits fix round 1 but not round 2 holds the issue at fix", async () => {
  // Round 1 fits: 2 launched + 8 + a reserve of 4 is 14. Round 2 doesn't:
  // 7 launched + 8 + 4 is 19.
  const { trace, summary } = await issueRun({
    claim: OPEN_FINDING_CLAIM,
    ops: {
      push: { ok: true, headSha: "ccccccc" },
      "prepare-review": { ok: true, diffPath: "/runs/r1.diff" },
    },
    agents: UNRESOLVED_ROUND,
    config: { maxSpawnsPerRun: 15 },
  });
  // Round 1's fixer and re-reviewer, and no round 2.
  assert.deepEqual(sessionAgents(trace), ["issue-pipeline-writer", READER]);
  const [item] = /** @type {SweepSummary} */ (summary).items;
  assert.deepEqual(
    [item?.stage, item?.outcome, item?.reason],
    ["fix", "in-progress", null],
  );
  assert.equal(releasedState(trace).log?.at(-1), HELD_AT_FIX);
});
