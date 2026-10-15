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

test("a sweep with nothing to do launches only the sweep", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: { sweep: sweepReply() },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1"]);
  assert.deepEqual(summary, sweepSummary({ items: [] }));
  snapshot(trace);
});

test("a lost claim is recorded as abandoned, with no item", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: { sweep: sweepReply({ items: [LOST_ISSUE] }), claim: LOST_CLAIM },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "i7-claim-2"]);
  assert.deepEqual(
    summary,
    sweepSummary({
      abandoned: [{ issue: 7, holder: "lane-b", commented: true }],
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
  ]);
  assert.deepEqual(
    summary,
    sweepSummary({
      abandoned: [{ issue: 7, holder: "lane-b", commented: true }],
      items: [
        {
          issue: 8,
          pr: 48,
          stage: "merge",
          outcome: "merged",
          reason: null,
          allocatedTokens: 400_000,
        },
      ],
    }),
  );
  snapshot(trace);
});

test("a sweep closes the parents it is given", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ parents: [PARENT_ISSUE] }),
      "close-parent": { ok: true, closed: true },
    },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "p5-close-2"]);
  assert.deepEqual(summary, sweepSummary({ parentsClosed: 1 }));
  snapshot(trace);
});

test("a failed claim is the sweep's item, with no state", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: { ok: false, error: "the issue is locked" },
    },
  });
  assert.deepEqual(launchKeys(trace), ["sweep-1", "i7-claim-2"]);
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: null,
          stage: null,
          outcome: "claim-failed",
          reason: "the issue is locked",
          allocatedTokens: null,
        },
      ],
    }),
  );
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
  assert.deepEqual(launchKeys(trace), ["sweep-1", "i7-claim-2", "i7-stop-3"]);
  const { request } = trace.at(-1);
  assert.equal(request.detail, "Expected aaaaaaa, found bbbbbbb.");
  assert.deepEqual(
    summary,
    sweepSummary({
      items: [
        {
          issue: 7,
          pr: 42,
          stage: "merge",
          outcome: "stopped",
          reason: "the PR branch changed outside the pipeline",
          allocatedTokens: 9,
        },
      ],
    }),
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
