// @ts-check
// Fixtures for driving one fix round (src/workflow/stages/fix.ts and
// rereview.ts) with recorded results: issue #7 at fix with an open
// correctness finding, and the steps from the fixer's launch to the re-review.
import { next } from "../src/workflow/stages/fix.ts";
import {
  CTX,
  openFinding,
  opReply,
  replied,
  stateWith,
} from "./workflow-review-test-kit.mjs";

/** @import { Launch, LaunchResult, StageState, Step } from "../src/workflow/stages/types.ts" */
/** @import { Finding, IssueState } from "../src/workflow/types.ts" */

/**
 * The steps of one fix round, from its first call to the re-review.
 * @typedef {{ begun: Step, fixed: Step, pushed: Step, prepared: Step, settled: Step }} Round
 */

const HEAD = "ccccccc";
const DIFF_PATH = "/runs/issue-7/r1.diff";
const F1 = openFinding("f1", ["correctness"]);
const FIXED = { fixed: ["f1"], disputed: [], summary: "Fixed the loop bound." };

// Issue #7 at fix with `findings`, its last review at bbbbbbb.
/** @param {Finding[]} [findings] @param {Partial<IssueState>} [fields] @returns {StageState} */
function fixState(findings = [F1], fields = {}) {
  return stateWith("fix", {
    reviewedSha: "bbbbbbb",
    nextFindingId: findings.length,
    findings,
    ...fields,
  });
}

// A re-reviewer's reply giving finding `id` the verdict `status`, with
// `newFindings` reported alongside.
/** @param {string} id @param {string} status @param {unknown[]} [newFindings] */
function verdict(id, status, newFindings = []) {
  return { results: [{ id, status, note: "Checked." }], newFindings };
}

// The steps of one round, from `given`, through the fixer's `fix` reply, the
// push and the prep, to the re-review with `rereviews` (by launch name).
/**
 * @param {StageState} given @param {unknown} [fix]
 * @param {Readonly<Record<string, LaunchResult>>} [rereviews]
 * @returns {Round}
 */
function round(given, fix = FIXED, rereviews = {}) {
  const begun = next(given, CTX, []);
  const [fixer] = launchesOf(begun);
  const fixed = next(begun.state, CTX, [replied(fixer.name, fix)]);
  const pushed = next(fixed.state, CTX, [opReply({ ok: true, headSha: HEAD })]);
  const prepared = next(pushed.state, CTX, [
    opReply({ ok: true, diffPath: DIFF_PATH }),
  ]);
  let settled = prepared;
  if (!prepared.done && prepared.launches[0].kind === "child") {
    const results = prepared.launches.map(
      ({ name }) => rereviews[name] ?? replied(name, verdict("f1", "resolved")),
    );
    settled = next(prepared.state, CTX, results);
  }
  return { begun, fixed, pushed, prepared, settled };
}

// The launches `step` asks for. A done step asks for none, so the round
// can't go on.
/** @param {Step} step @returns {readonly [Launch, ...Launch[]]} */
function launchesOf(step) {
  if (step.done) {
    throw new Error("the fix round finished before its fixer launched");
  }
  return step.launches;
}

// The step after `step`'s state is saved.
/** @param {Step} step @returns {Step} */
function saved(step) {
  return next(step.state, CTX, [opReply({ ok: true })]);
}

export { DIFF_PATH, F1, FIXED, fixState, HEAD, round, saved, verdict };
