// The built workflow's same-sweep rebase after a merge refused as behind, run
// through workflow-harness.mjs. Each test pins the summary, the ops requests
// the merge goes through and the state saved at release, read through
// stage-outcome-test-kit.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  releasedState,
  requestFor,
  sessionAgents,
} from "./stage-outcome-test-kit.mjs";
import {
  finishRun,
  issueSummary,
  SECURED,
} from "./workflow-finish-run-kit.mjs";

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

test("a merge refused as behind rebases, re-runs the tests and merges", async () => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { ...REBASED_OPS, merge: [BEHIND, { ok: true, merged: true }] },
  });
  const { testsOnly } = requestFor(trace, "verify");
  assert.equal(testsOnly, true);
  // No acceptance or security session runs between the rebase and the merge.
  assert.deepEqual(sessionAgents(trace), []);
  assert.deepEqual(
    summary,
    issueSummary({
      stage: "merge",
      outcome: "merged",
    }),
  );
});

test("a second behind in one sweep waits at sync for the next sweep", async () => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { ...REBASED_OPS, merge: [BEHIND, BEHIND] },
  });
  const { testsOnly } = requestFor(trace, "verify");
  assert.equal(testsOnly, true);
  const state = releasedState(trace);
  assert.deepEqual([state.stage, state.passedSha], ["sync", "ddddddd"]);
  const notes = (state.log ?? []).map((line) =>
    line.slice(line.indexOf(" ") + 1),
  );
  const now = notes.indexOf("merge deferred: behind; rebasing now");
  const later = notes.indexOf("merge deferred: behind; will rebase next sweep");
  assert.ok(now >= 0 && later > now, notes.join("\n"));
  assert.deepEqual(summary, issueSummary({ stage: "sync" }));
});

test("a merge refused as conflict waits at sync for the next sweep", async () => {
  const { trace, summary } = await finishRun({
    stage: "merge",
    fields: SECURED,
    ops: { merge: { ok: true, merged: false, reason: "conflict" } },
  });
  assert.equal(releasedState(trace).stage, "sync");
  assert.deepEqual(summary, issueSummary({ stage: "sync" }));
});
