// @ts-check
// The built workflow's sweep and claim paths, and closing parents, run through
// workflow-harness.mjs. Each test pins the summary and the ops requests the
// sweep's effects go through, read through stage-outcome-test-kit.mjs.
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
};

test("a sweep with nothing to do claims nothing and cleans up", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: { sweep: sweepReply(), cleanup: ROUTINE_OPS.cleanup },
  });
  assert.throws(() => requestFor(trace, "claim"));
  const { skip } = requestFor(trace, "cleanup");
  assert.equal(skip, null);
  assert.deepEqual(summary, sweepSummary({ items: [] }));
});

test("a lost claim is recorded as abandoned, with no item", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: LOST_CLAIM,
      cleanup: ROUTINE_OPS.cleanup,
    },
  });
  assert.throws(() => releasedState(trace));
  assert.deepEqual(
    summary,
    sweepSummary({
      abandoned: [{ issue: LOST_ISSUE, holder: "lane-b", commented: true }],
    }),
  );
});

test("after a lost claim, the next candidate resumes from its saved lease", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      ...ROUTINE_OPS,
      sweep: sweepReply({ items: [LOST_ISSUE, RESUMED_ISSUE] }),
      claim: [LOST_CLAIM, claimAt("merge", CRASHED_LEASE)],
      merge: { ok: true, merged: true },
    },
  });
  const { number } = requestFor(trace, "merge");
  assert.equal(number, RESUMED_ISSUE);
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
        },
      ],
    }),
  );
});

test("a sweep closes the parents it is given", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ parents: [PARENT_ISSUE] }),
      cleanup: ROUTINE_OPS.cleanup,
      "close-parent": { ok: true, closed: true },
    },
  });
  const { number } = requestFor(trace, "close-parent");
  assert.equal(number, PARENT_ISSUE);
  assert.deepEqual(summary, sweepSummary({ parentsClosed: 1 }));
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
  assert.deepEqual(sessionAgents(trace), []);
  assert.throws(() => releasedState(trace));
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
        },
      ],
    }),
  );
});

test("a claim waiting for an answer is the sweep's item and launches nothing", async () => {
  const { trace, summary } = await runWorkflow({
    args: WORKFLOW_ARGS,
    ops: {
      sweep: sweepReply({ items: [LOST_ISSUE] }),
      claim: { ok: true, waiting: "answer" },
      cleanup: ROUTINE_OPS.cleanup,
    },
  });
  assert.deepEqual(sessionAgents(trace), []);
  assert.throws(() => releasedState(trace));
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
        ...claimAt("merge", { pr: 42, headSha: "aaaaaaa" }),
        remoteHead: "bbbbbbb",
      },
    },
  });
  const { code, detail } = requestFor(trace, "stop");
  assert.deepEqual([code, detail], [null, "Expected aaaaaaa, found bbbbbbb."]);
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
