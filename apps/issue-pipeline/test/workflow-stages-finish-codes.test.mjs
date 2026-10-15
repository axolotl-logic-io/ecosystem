// @ts-check
// The built workflow's security stops, run through workflow-harness.mjs: a
// stop for an open security finding carries the finding's harm as its code.
// Each test pins the launch keys, the stop request's code and the summary by
// hand, with no snapshot.
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

/** @import { OpLaunch } from "../src/workflow/stages/types.ts" */
/** @import { Scripted } from "./workflow-harness.mjs" */

// Issue #7 with acceptance passed at fffffff.
const ACCEPTED = {
  pr: 42,
  headSha: "fffffff",
  reviewedSha: "fffffff",
  verifiedSha: "fffffff",
  verifySummary: "test: passed",
  implemented: true,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  acceptReason: "Does what #7 asks.",
  allocated: 880_000,
};
// A security reviewer's finding that harms the users.
const LEAK = {
  file: "src/a.ts",
  line: 9,
  title: "Logs the user's email",
  evidence: "console.log(user.email) on every request.",
  suggestion: "Drop the log line.",
  category: "user-harm",
};

// A run of issue #7 claimed at `stage` with `fields`, with ops and agents.
/**
 * @param {object} run
 * @param {string} run.stage
 * @param {object} run.fields
 * @param {Record<string, Scripted>} [run.ops]
 * @param {Record<string, Scripted>} [run.agents]
 * @returns {ReturnType<typeof runWorkflow>}
 */
function codesRun({ stage, fields, ops = {}, agents = {} }) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [ISSUE] }),
      claim: claimAt(stage, fields),
      ...ops,
    },
    agents,
  });
}

// The summary of issue #7 stopped at `stage` by LEAK past its fix rounds.
/** @param {string} stage @returns {object} */
function leakStopped(stage) {
  return sweepSummary({
    items: [
      {
        issue: 7,
        pr: 42,
        stage,
        outcome: "stopped",
        reason:
          "security review (user-harm): Logs the user's email is still open after 2 fix rounds",
        allocatedTokens: 940_000,
        rebaseAllocatedTokens: 0,
      },
    ],
  });
}

test("a security finding past the fix rounds stops with its harm as the code", async () => {
  const { trace, summary } = await codesRun({
    stage: "security",
    fields: { ...ACCEPTED, securityRounds: 2 },
    ops: { "prepare-review": { ok: true, headSha: "fffffff" } },
    agents: { "i7-security": replyWith({ findings: [LEAK] }) },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-prep-3",
    "i7-security-4",
    "i7-stop-5",
    "cleanup-6",
  ]);
  const { code } = /** @type {OpLaunch["payload"]} */ (
    trace.at(-2)?.request ?? {}
  );
  assert.equal(code, "user-harm");
  assert.deepEqual(summary, leakStopped("security"));
});

test("an open security finding stops the merge with its harm as the code", async () => {
  const open = { ...LEAK, id: "f1", lenses: ["security"], status: "open" };
  const { trace, summary } = await codesRun({
    stage: "merge",
    fields: {
      ...ACCEPTED,
      allocated: 940_000,
      findings: [{ ...open, disputed: false }],
    },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-stop-3",
    "cleanup-4",
  ]);
  const { code } = /** @type {OpLaunch["payload"]} */ (
    trace.at(-2)?.request ?? {}
  );
  assert.equal(code, "user-harm");
  assert.deepEqual(summary, leakStopped("merge"));
});
