// @ts-check
// The built workflow's sweep and claim paths, and closing parents, run through
// workflow-harness.mjs. Each test pins the launch keys and the summary by
// hand, and the whole trace in workflow-stages-claim.test.mjs.snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflow } from "./workflow-harness.mjs";
import {
  claimAt,
  launchKeys,
  ROUTINE_OPS,
  sweepReply,
  sweepSummary,
  WORKFLOW_ARGS,
} from "./workflow-stages-fixtures.mjs";

/** @import { OpLaunch, SweepSummary } from "../src/workflow/stages/types.ts" */

// The issue another lane claims first, the issue resumed after it, and a
// parent of split issues.
const LOST_ISSUE = 7;
const RESUMED_ISSUE = 8;
const PARENT_ISSUE = 5;
// The error for a launch with no scripted reply.
const UNSCRIPTED_CLAIM = /no scripted reply for i7-claim-2/u;
// The claim another lane wins first.
const LOST_CLAIM = { ok: true, lost: true, holder: "lane-b", posted: true };
// The abandoned-lease scenario's issue: saved at merge by a lane that crashed.
const CRASHED_LEASE = {
  number: RESUMED_ISSUE,
  lease: { lane: "lane-c", sweepId: "smv9a0000", at: "2026-10-15T06:00:00Z" },
  pr: 48,
  headSha: "8888888",
  reviewedSha: "8888888",
  verifiedSha: "8888888",
  acceptReason: "Does what #8 asks.",
  verifySummary: "test: passed",
  allocated: 400_000,
};

test("a sweep with nothing to do launches the sweep and the cleanup", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: { sweep: sweepReply(), cleanup: ROUTINE_OPS.cleanup },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "cleanup-2"]);
  const { skip } = /** @type {OpLaunch["payload"]} */ (trace[1]?.request ?? {});
  assert.equal(skip, null);
  assert.deepEqual(summary, sweepSummary({ items: [] }));
  snapshot(trace);
});

test("a lost claim is recorded as abandoned, with no item", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: LOST_CLAIM,
      cleanup: ROUTINE_OPS.cleanup,
    },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "i7-claim-2", "cleanup-3"]);
  assert.deepEqual(
    summary,
    sweepSummary({
      abandoned: [{ issue: LOST_ISSUE, holder: "lane-b", commented: true }],
    }),
  );
  snapshot(trace);
});

test("after a lost claim, the next candidate resumes from its saved lease", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [LOST_ISSUE, RESUMED_ISSUE] }),
      claim: [LOST_CLAIM, claimAt("merge", CRASHED_LEASE)],
      merge: { ok: true, merged: true },
    },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i8-claim-3",
    "i8-merge-4",
    "cleanup-5",
  ]);
  assert.deepEqual(
    summary,
    sweepSummary({
      abandoned: [{ issue: LOST_ISSUE, holder: "lane-b", commented: true }],
      items: [
        {
          issue: RESUMED_ISSUE,
          pr: 48,
          stage: "merge",
          outcome: "merged",
          reason: null,
          allocatedTokens: 400_000,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
  snapshot(trace);
});

test("a claimed branch whose head isn't the saved one stops as changed", async () => {
  const saved = { number: RESUMED_ISSUE, pr: 48, headSha: "8888888" };
  const claim = { ...claimAt("merge", saved), remoteHead: "9999999" };
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [RESUMED_ISSUE] }),
      claim,
    },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i8-claim-2",
    "i8-stop-3",
    "cleanup-4",
  ]);
  const [item] = /** @type {SweepSummary} */ (summary).items;
  assert.deepEqual(
    [item?.outcome, item?.reason],
    ["stopped", "the PR branch changed outside the pipeline"],
  );
});

test("a sweep closes the parents it is given", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ parents: [PARENT_ISSUE] }),
      cleanup: ROUTINE_OPS.cleanup,
      "close-parent": { ok: true, closed: true },
    },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "p5-close-2", "cleanup-3"]);
  assert.deepEqual(summary, sweepSummary({ parentsClosed: 1 }));
  snapshot(trace);
});

test("a failed claim is the sweep's item, with no state", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: { ok: false, error: "the issue is locked" },
      cleanup: ROUTINE_OPS.cleanup,
    },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "i7-claim-2", "cleanup-3"]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: LOST_ISSUE,
          pr: null,
          stage: null,
          outcome: "claim-failed",
          reason: "the issue is locked",
          allocatedTokens: null,
          rebaseAllocatedTokens: null,
        },
      ],
    }),
  );
});

test("a claim waiting for an answer is the sweep's item and launches nothing", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: { ok: true, waiting: "answer" },
      cleanup: ROUTINE_OPS.cleanup,
    },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "i7-claim-2", "cleanup-3"]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: null,
          stage: null,
          outcome: "waiting-for-answer",
          reason: "waiting for an answer to the pipeline's questions",
          allocatedTokens: null,
          rebaseAllocatedTokens: null,
        },
      ],
    }),
  );
  snapshot(trace);
});

test("a PR branch that moved outside the pipeline stops the claimed issue", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: {
        ...claimAt("merge", { pr: 42, headSha: "aaaaaaa", allocated: 9 }),
        remoteHead: "bbbbbbb",
      },
    },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-stop-3",
    "cleanup-4",
  ]);
  const { detail } = /** @type {OpLaunch["payload"]} */ (
    trace.at(-2)?.request ?? {}
  );
  assert.equal(detail, "Expected aaaaaaa, found bbbbbbb.");
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: LOST_ISSUE,
          pr: 42,
          stage: "merge",
          outcome: "stopped",
          reason: "the PR branch changed outside the pipeline",
          allocatedTokens: 9,
          rebaseAllocatedTokens: 0,
        },
      ],
    }),
  );
});

// A sweep with nothing to do whose cleanup answers `cleanup`.
/** @param {object} cleanup @returns {ReturnType<typeof runWorkflow>} */
function cleanupRun(cleanup) {
  return runWorkflow({
    args: WORKFLOW_ARGS,
    ops: { sweep: sweepReply(), cleanup },
  });
}

test("the cleanup's list of worktrees is the summary's cleanup log", async () => {
  const worktrees = [
    { issue: 3, outcome: "removed" },
    { issue: 4, outcome: "kept", why: "the issue is open" },
  ];
  const { summary } = await cleanupRun({ ok: true, worktrees });
  assert.deepEqual(
    summary,
    sweepSummary({ cleanup: { worktrees, error: null } }),
  );
});

test("a failed cleanup is reported in the summary, not thrown", async () => {
  const error = "timed out waiting for the clone lock";
  const { summary } = await cleanupRun({ ok: false, error });
  assert.deepEqual(
    summary,
    sweepSummary({ cleanup: { worktrees: [], error } }),
  );
});

test("a launch with no scripted reply rejects the run, naming its key", async () => {
  await assert.rejects(
    runWorkflow({
      args: WORKFLOW_ARGS,
      ops: { sweep: sweepReply({ items: [LOST_ISSUE] }) },
    }),
    UNSCRIPTED_CLAIM,
  );
});
