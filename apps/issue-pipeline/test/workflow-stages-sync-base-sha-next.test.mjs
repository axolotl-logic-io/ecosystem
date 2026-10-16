// @ts-check
// Sync's finish-sync request carries the baseSha sync-base kept its conflict
// on (#279), so the op checks the resolution against that commit, also after a
// continuation resolver. Without a baseSha the request is as before
// (workflow-stages-sync-next.test.mjs).
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
} from "./workflow-checks-test-kit.mjs";

/** @import { Step } from "../src/workflow/stages/types.ts" */

const BASE_SHA = "abcdef0000000000000000000000000000000000";
const CONFLICT = {
  ok: true,
  conflict: true,
  inRebase: true,
  conflicts: ["src/a.ts"],
  baseSha: BASE_SHA,
};
const KEPT_BOTH = { status: "fixed", summary: "Kept both changes." };
const HANDOFF = { status: "handoff", summary: "Half done." };
const FINISH = {
  op: "finish-sync",
  payload: {
    number: 7,
    abort: false,
    reason: "Kept both changes.",
    baseSha: BASE_SHA,
  },
};

// The step after the one session `step` launched replies `reply`.
/** @param {Step} step @param {unknown} reply @returns {Step} */
function answered(step, reply) {
  if (step.done) {
    throw new Error("the step ended instead of launching");
  }
  const [launch] = step.launches;
  return after(next, step, CTX, sessionResult(launch.name, reply));
}

/** @returns {Step} */
function conflicted() {
  return replied(next, next(stateAt("sync"), CTX, []), CONFLICT);
}

test("finish-sync gets the baseSha the conflict was kept on", () => {
  assert.deepEqual(opsRequests(answered(conflicted(), KEPT_BOTH)), [FINISH]);
});

test("finish-sync after a continuation still gets the baseSha", () => {
  const continuing = answered(conflicted(), HANDOFF);
  assert.deepEqual(opsRequests(answered(continuing, KEPT_BOTH)), [FINISH]);
});
