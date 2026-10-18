// @ts-check
// The reviewer machine's `accept` entry for issue #7 (#423): a state today's
// `accept` stage saved, the data locate builds from it, the prepare-accept
// check's reply, and a step through `transition` from the accept data.
import { locate } from "../src/roles/reviewer/locate.ts";
import { transition } from "../src/roles/reviewer/machine.ts";
import { PR, RESOLVED } from "./reviewer-role-test-kit.mjs";
import { roleContext } from "./role-context-fixtures.mjs";

/** @import { State } from "../src/state.ts" */
/** @import { Step } from "../src/roles/machine.ts" */
/** @import { ReviewerData, ReviewerState } from "../src/roles/reviewer/locate.ts" */
/** @import { ReviewerResult } from "../src/roles/reviewer/machine.ts" */

const SHA_LENGTH = 40;
// The head the checks verified, which acceptance judges.
const VERIFIED = "e".repeat(SHA_LENGTH);
// The verified head's changes' patch id, as prepare-review replies it.
const FINAL_PATCH_ID = "9".repeat(SHA_LENGTH);
// The head and patch id acceptance last passed, and how a kept verdict
// names that head.
const PASSED = "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff";
const PASSED_PATCH_ID = "1".repeat(SHA_LENGTH);
const KEPT_TEXT = "acceptance kept: changes unchanged since c0ffeec0ffee";
const VERIFY_SUMMARY = "checks passed: npm test";
const FINAL_DIFF = "/runs/issue-7/final.diff";
const NEXT_FINDING_ID = 2;
const PASS = { verdict: "pass", reason: "It does what #7 asks." };
const FAIL = { verdict: "fail", reason: "The wiki misses the new stage." };

// Issue #7 as today's `accept` stage finds it after checks: verified at
// VERIFIED, with an earlier acceptance's head and patch id.
/** @type {State} */
const OLD_ACCEPT_STATE = {
  version: 1,
  number: 7,
  depth: 0,
  stage: "accept",
  lease: null,
  pr: PR,
  headSha: VERIFIED,
  verifiedSha: VERIFIED,
  verifySummary: VERIFY_SUMMARY,
  reviewedSha: VERIFIED,
  reviewedPatchId: FINAL_PATCH_ID,
  acceptedSha: PASSED,
  acceptedPatchId: PASSED_PATCH_ID,
  spec: "## Behaviour\n\n1. src/a.ts does the thing.",
  findings: [RESOLVED],
  nextFindingId: NEXT_FINDING_ID,
  round: 1,
  log: [],
};

// The prepare-accept check's `ok` reply: prepare-review's reply at the
// verified head.
const FINAL = {
  ok: true,
  headSha: VERIFIED,
  headTree: "cccccccccccccccccccccccccccccccccccccccc",
  baseSha: "dddddddddddddddddddddddddddddddddddddddd",
  patchId: FINAL_PATCH_ID,
  diffPath: FINAL_DIFF,
  diffLines: "3",
  changedFiles: ["src/a.ts"],
};

/** @param {Partial<State>} [fields] @returns {{ at: ReviewerState, data: ReviewerData }} where locate starts issue #7 at accept */
function acceptLocated(fields = {}) {
  return locate({ ...OLD_ACCEPT_STATE, ...fields }, roleContext());
}

/**
 * The step `result` (with `reply`) takes from `at`, from `data`.
 * @param {ReviewerState} at
 * @param {ReviewerResult} result
 * @param {unknown} [reply]
 * @param {ReviewerData} [data]
 * @returns {Step<ReviewerState, ReviewerData>}
 */
function acceptStep(at, result, reply = null, data = acceptLocated().data) {
  return transition({ at, data }, { name: result, reply });
}

/** @returns {ReviewerData} the accept data once prepare-accept replied */
function finalData() {
  return acceptStep("prepare-accept", "ok", FINAL).state.data;
}

export {
  acceptLocated,
  acceptStep,
  FAIL,
  FINAL,
  FINAL_DIFF,
  FINAL_PATCH_ID,
  finalData,
  KEPT_TEXT,
  NEXT_FINDING_ID,
  OLD_ACCEPT_STATE,
  PASS,
  PASSED,
  PASSED_PATCH_ID,
  VERIFIED,
  VERIFY_SUMMARY,
};
