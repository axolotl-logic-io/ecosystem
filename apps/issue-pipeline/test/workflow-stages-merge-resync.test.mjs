// The built workflow's same-sweep rebase after a merge refused as behind, run
// through workflow-harness.mjs. Each test pins the launch keys by hand, and
// the whole trace in workflow-stages-merge-resync.test.mjs.snapshot.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  finishRun,
  issueSummary,
  SECURED,
} from "./workflow-finish-run-kit.mjs";
import { launchKeys } from "./workflow-stages-fixtures.mjs";

const BEHIND = { ok: true, merged: false, reason: "behind" };
// A clean rebase onto a moved base, then passing tests and CI on its head.
const REBASED_OPS = {
  "sync-base": { ok: true, conflict: false, changed: true, headSha: "ddddddd" },
  verify: {
    ok: true,
    headSha: "ddddddd",
    pass: true,
    checks: [{ id: "test", pass: true, detail: "passed" }],
  },
  "ci-status": { ok: true, status: "pass" },
};

// The launch keyed `key` in `trace`.
function launchOf(trace, key) {
  return trace.find((entry) => entry.key === key);
}

test("a merge refused as behind rebases, re-runs the tests and merges", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { ...REBASED_OPS, merge: [BEHIND, { ok: true, merged: true }] },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-merge-3",
    "i7-sync-4",
    "i7-verify-5",
    "i7-ci-6",
    "i7-merge-7",
    "cleanup-8",
  ]);
  assert.equal(launchOf(trace, "i7-verify-5").request.testsOnly, true);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "merge",
      outcome: "merged",
      allocatedTokens: 940_000,
    }),
  );
  snapshot(trace);
});

test("a second behind in one sweep waits at sync for the next sweep", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { ...REBASED_OPS, merge: [BEHIND, BEHIND] },
  });
  assert.deepEqual(launchKeys(trace).slice(-3), [
    "i7-merge-7",
    "i7-release-8",
    "cleanup-9",
  ]);
  const { state } = launchOf(trace, "i7-release-8").request;
  assert.deepEqual([state.stage, state.passedSha], ["sync", "ddddddd"]);
  const notes = state.log.map((line) => line.slice(line.indexOf(" ") + 1));
  const now = notes.indexOf("merge deferred: behind; rebasing now");
  const later = notes.indexOf("merge deferred: behind; will rebase next sweep");
  assert.ok(now >= 0 && later > now, notes.join("\n"));
  assert.deepEqual(
    summary,
    issueSummary({ stage: "sync", allocatedTokens: 940_000 }),
  );
  snapshot(trace);
});

test("a merge refused as conflict waits at sync for the next sweep", async ({
  assert: { snapshot },
}) => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { merge: { ok: true, merged: false, reason: "conflict" } },
  });
  assert.deepEqual(launchKeys(trace), [
    "sweep-1",
    "i7-claim-2",
    "i7-merge-3",
    "i7-release-4",
    "cleanup-5",
  ]);
  assert.equal(launchOf(trace, "i7-release-4").request.state.stage, "sync");
  assert.deepEqual(
    summary,
    issueSummary({ stage: "sync", allocatedTokens: 940_000 }),
  );
  snapshot(trace);
});
