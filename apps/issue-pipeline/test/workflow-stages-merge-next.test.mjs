// The merge's step machine (src/workflow/stages/merge.ts), driven directly
// with recorded replies and a fixed clock. The trace tests run it through the
// sweep; these pin the merge request and each answer's step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/merge.ts";
import {
  deferral,
  deferredFrom,
  NETWORK_FAILURE,
} from "./deferral-test-kit.mjs";
import {
  CTX,
  replied,
  STAMP,
  stateWith,
  VERIFIED,
} from "./workflow-finish-test-kit.mjs";

const OPEN = {
  id: "f1",
  file: "a.ts",
  line: 3,
  title: "Leaks the token",
  evidence: "It logs the token.",
  suggestion: "Drop the log line.",
  lenses: ["security"],
  category: "user-harm",
  status: "open",
  disputed: false,
};
const ACCEPTED = { acceptReason: "Does it." };
const QUEUED = {
  ok: true,
  merged: false,
  reason: "queued",
  waitingFor: 3,
  waitingForPr: 30,
};
const WAIT_NOTE = "merge waits for #3 (older PR #30)";

function mergeState(fields = {}, item = {}) {
  return stateWith("merge", { ...ACCEPTED, ...fields }, item);
}

// The merge's step after ops answers `reply`.
function answered(reply, fields = {}, item = {}) {
  return replied(next, next(mergeState(fields, item), CTX, []), reply);
}

test("an open finding stops the merge before any launch", () => {
  const step = next(mergeState({ findings: [OPEN] }), CTX, []);
  assert.equal(step.done, true);
  assert.equal(Object.hasOwn(step, "launches"), false);
  assert.deepEqual(step.stop, {
    reason:
      "security review (user-harm): Leaks the token is still open after 2 fix rounds",
    detail:
      "- f1 (security: user-harm) [a.ts:3] Leaks the token\n  Evidence: It logs the token.\n  Suggestion: Drop the log line.",
    code: "user-harm",
  });
});

test("an open finding from another lens stops with no code", () => {
  const finding = { ...OPEN, lenses: ["tests"], category: null };
  const step = next(mergeState({ findings: [finding] }), CTX, []);
  assert.deepEqual(step.stop, {
    reason: "open blocking findings remain at merge time",
    detail:
      "- f1 [a.ts:3] Leaks the token\n  Evidence: It logs the token.\n  Suggestion: Drop the log line.",
    code: null,
  });
});

test("the merge request carries the state and the summary", () => {
  const given = mergeState();
  const step = next(given, CTX, []);
  assert.equal(step.state.phase, "decide");
  assert.deepEqual(step.launches, [
    {
      kind: "op",
      name: "merge",
      op: "merge",
      payload: {
        number: 7,
        state: given.st,
        expectedSha: VERIFIED,
        mergeOrder: true,
        summary: "Checks: test: ok\n\nAcceptance: Does it.",
      },
    },
  ]);
  assert.deepEqual(given, mergeState());
});

test("the summary notes a verdict given before a clean rebase", () => {
  const step = next(mergeState({}, { rebasedOnly: true }), CTX, []);
  assert.equal(
    step.launches[0].payload.summary,
    "Checks: test: ok\n\nAcceptance: Does it. (passed before a clean rebase onto integration)",
  );
});

test("a merged PR closes the issue for the sweep", () => {
  const step = answered({ ok: true, merged: true });
  assert.deepEqual(
    [step.done, step.state.closed, step.state.outcome, step.stop],
    [true, true, "merged", null],
  );
});

test("a merge resets the rebase pool and ends the re-check", () => {
  const step = answered(
    { ok: true, merged: true },
    { rebaseAllocated: 160_000, rechecking: true },
  );
  assert.deepEqual(
    [step.state.st.rebaseAllocated, step.state.st.rechecking],
    [0, false],
  );
});

test("a queued merge notes the wait once and stays at merge", () => {
  const step = answered(QUEUED);
  assert.equal(step.done, true);
  assert.equal(step.state.st.stage, "merge");
  assert.deepEqual(step.state.st.log, [`${STAMP} ${WAIT_NOTE}`]);
  const log = [`2026-10-14T09:00Z ${WAIT_NOTE}`];
  const again = answered(QUEUED, { log });
  assert.deepEqual(again.state.st.log, log);
  assert.equal(again.stop, null);
});

const BEHIND = { ok: true, merged: false, reason: "behind" };

test("a merge refused as behind goes back to sync to rebase now", () => {
  const step = answered(BEHIND);
  assert.equal(step.done, true);
  assert.equal(step.stop, null);
  assert.deepEqual(
    [step.state.st.passedSha, step.state.st.stage],
    [VERIFIED, "sync"],
  );
  assert.equal(step.state.resynced, true);
  assert.deepEqual(step.state.st.log, [
    `${STAMP} merge deferred: behind; rebasing now`,
  ]);
});

test("a second behind in one sweep waits for the next sweep", () => {
  const step = answered(BEHIND, {}, { resynced: true });
  assert.equal(step.state.resynced, true);
  assert.equal(step.state.st.stage, "sync");
  assert.deepEqual(step.state.st.log, [
    `${STAMP} merge deferred: behind; will rebase next sweep`,
  ]);
});

test("a merge refused as conflict waits for the next sweep", () => {
  const step = answered({ ok: true, merged: false, reason: "conflict" });
  assert.equal(step.state.resynced, false);
  assert.deepEqual(
    [step.state.st.passedSha, step.state.st.stage],
    [VERIFIED, "sync"],
  );
  assert.deepEqual(step.state.st.log, [
    `${STAMP} merge deferred: conflict; will rebase next sweep`,
  ]);
});

test("a merge step that failed on the network defers to the next sweep", () => {
  const step = answered({ ok: false, error: "gh exited 1: HTTP 502" });
  const given = stateWith("merge");
  assert.deepEqual(deferral(step), deferredFrom(given, "merge", STAMP));
  const unreachable = answered({ ok: false, error: NETWORK_FAILURE });
  assert.equal(unreachable.stop, null);
});

test("a failed merge step or a refused merge stops", () => {
  assert.deepEqual(answered({ ok: false, error: "gh failed" }).stop, {
    reason: "the merge step failed",
    detail: "gh failed",
    code: null,
  });
  assert.deepEqual(
    answered({ ok: true, merged: false, reason: "blocked" }).stop,
    {
      reason: "GitHub refused the merge",
      detail: "blocked",
      code: null,
    },
  );
  assert.deepEqual(answered({ ok: true, merged: false }).stop, {
    reason: "GitHub refused the merge",
    detail: null,
    code: null,
  });
});
