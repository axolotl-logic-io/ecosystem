// @ts-check
// A failed acceptance check sent through a fix round (#266), driven through
// the accept and fix step machines directly with recorded results: the fail
// moves the issue to fix, the round's acceptance re-reviewer resolves the
// finding, the issue moves to checks without a rebase (#340), and a later
// pass moves it to security.
import assert from "node:assert/strict";
import { test } from "node:test";
import { REREVIEW_SCHEMA } from "../src/workflow/review-schemas.ts";
import { next as acceptNext } from "../src/workflow/stages/accept.ts";
import { decided, replied, stateWith } from "./workflow-finish-test-kit.mjs";
import { round, saved } from "./workflow-fix-test-kit.mjs";
import { CTX } from "./workflow-review-test-kit.mjs";

/** @import { StageState, Step } from "../src/workflow/stages/types.ts" */

// `step`'s issue as the next stage's first call sees it.
/** @param {Step} step @param {string} [stage] @returns {StageState} */
function begunFrom(step, stage = step.state.st.stage) {
  return {
    ...step.state,
    st: { ...step.state.st, stage },
    phase: "begin",
    carry: null,
  };
}

test("a failed acceptance is fixed, re-reviewed, then accepted", () => {
  const fail = { verdict: "fail", reason: "The wiki misses the new stage." };
  const failed = decided(acceptNext, stateWith("accept"), fail);
  const atFix = replied(acceptNext, failed, { ok: true });
  assert.deepEqual([atFix.done, atFix.stop], [true, null]);
  assert.equal(atFix.state.st.stage, "fix");

  const { prepared, settled } = round(begunFrom(atFix));
  assert.equal(prepared.done, false);
  assert.deepEqual(
    prepared.launches.map((launch) => {
      assert.ok(launch.kind === "child");
      return [launch.name, launch.model, launch.schema];
    }),
    [["rereview-acceptance-r1", CTX.models.acceptance, REREVIEW_SCHEMA]],
  );
  const atChecks = saved(settled);
  assert.deepEqual([atChecks.done, atChecks.stop], [true, null]);
  assert.equal(atChecks.state.st.stage, "checks");

  const pass = { verdict: "pass", reason: "Does what #7 asks." };
  const passed = decided(acceptNext, begunFrom(atChecks, "accept"), pass);
  assert.deepEqual([passed.done, passed.stop], [true, null]);
  assert.equal(passed.state.st.stage, "security");
});
