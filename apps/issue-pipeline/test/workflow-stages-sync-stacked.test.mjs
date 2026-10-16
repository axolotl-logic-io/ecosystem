// @ts-check
// Sync's step machine for a stacked issue (#268): sync-base gets what the
// issue is stacked on, and the stage keeps what the reply says it is stacked
// on now, after a conflict only once the resolution is pushed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { next } from "../src/workflow/stages/sync.ts";
import { opsRequests } from "./stage-outcome-test-kit.mjs";
import {
  after,
  CTX,
  replied,
  sessionResult,
  stateAt,
  stepComment,
} from "./workflow-checks-test-kit.mjs";

/** @import { OpResult, Step } from "../src/workflow/stages/types.ts" */
/** @typedef {Parameters<typeof stateAt>[1]} Fields */
const HEAD = "dddddddddddddddd";
const PREREQ = 5;
// What the issue is stacked on before the sync, and its prerequisite's head
// after it.
const STACKED = { issue: PREREQ, headSha: "aaaaaaaaaaaaaaaa" };
const MOVED = { issue: PREREQ, headSha: "bbbbbbbbbbbbbbbb" };
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
  stackedOn: MOVED,
};
const KEPT_BOTH = { status: "fixed", summary: "Kept both changes." };
const RESOLVED = { ok: true, resolved: true, headSha: HEAD };
const ABORTED = { ok: true, resolved: false, reason: "aborted" };
const STACKED_FIELDS = { stackedOn: STACKED };

// Sync's step after its rebase replies with `reply`.
/** @param {OpResult["reply"]} reply @param {Fields} [fields] @returns {Step} */
function synced(reply, fields = STACKED_FIELDS) {
  return replied(next, next(stateAt("sync", fields), CTX, []), reply);
}

// The step that finishes a resolved conflict, and the finish-sync payload.
/** @returns {{ finishing: Step, payload: unknown }} */
function finishingConflict() {
  const resolver = sessionResult("conflicts-1", KEPT_BOTH);
  const finishing = after(next, synced(CONFLICT), CTX, resolver);
  const [request] = opsRequests(finishing);
  return { finishing, payload: request?.payload };
}

test("a stacked issue's sync-base request carries what it is stacked on", () => {
  const begun = next(stateAt("sync", STACKED_FIELDS), CTX, []);
  assert.deepEqual(opsRequests(begun), [
    {
      op: "sync-base",
      payload: { number: 7, keepConflict: true, stackedOn: STACKED },
    },
  ]);
});

test("a clean sync onto the base after the prerequisite merged unstacks the issue", () => {
  const reply = { ok: true, changed: true, headSha: HEAD, stackedOn: null };
  const step = synced(reply);
  assert.equal(step.state.st.stage, "checks");
  assert.equal(step.state.st.stackedOn, null);
  assert.deepEqual(step.comments, [
    stepComment(
      "sync",
      "Rebased onto integration without conflicts; the head is now dddddddddddd. Rebases aren't re-reviewed; the checks run again.",
    ),
  ]);
});

test("a clean sync onto the prerequisite's moved head keeps the issue stacked on that head", () => {
  const reply = { ok: true, changed: true, headSha: HEAD, stackedOn: MOVED };
  const step = synced(reply);
  assert.deepEqual(step.state.st.stackedOn, MOVED);
  assert.ok(
    step.comments[0]?.body.startsWith(
      `Rebased onto agent/issue-${PREREQ} (#${PREREQ}) without conflicts`,
    ),
  );
});

test("finish-sync gets the conflict's stackedOn, which the issue takes once resolved", () => {
  const { finishing, payload } = finishingConflict();
  assert.deepEqual(payload, {
    number: 7,
    abort: false,
    reason: "Kept both changes.",
    stackedOn: MOVED,
  });
  const step = replied(next, finishing, RESOLVED);
  assert.equal(step.state.st.stage, "checks");
  assert.deepEqual(step.state.st.stackedOn, MOVED);
});

test("a rejected resolution leaves what the issue is stacked on as it was", () => {
  const { finishing } = finishingConflict();
  const step = replied(next, finishing, ABORTED);
  assert.equal(step.state.st.stage, "sync");
  assert.deepEqual(step.state.st.stackedOn, STACKED);
});
