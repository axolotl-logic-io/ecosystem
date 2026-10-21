// @ts-check
// Requests and matching revision observations for the merge op's real worlds.
import { setCurrentRevision } from "./ops-publish-revision-double.mjs";
import { approvedState, ISSUE, PR } from "./ops-publish-test-kit.mjs";

const TARGET_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @param {World} w @returns {{ code: string, inputs: string }} */
function approvedOf(w) {
  return { code: w.sha, inputs: "inputs-1" };
}

/** @param {World} w @param {object} [extra] @returns {object} */
function request(w, extra = {}) {
  const approved = approvedOf(w);
  return {
    number: ISSUE,
    state: approvedState(approved),
    expectedSha: w.sha,
    revision: approved,
    mergeQueue: null,
    summary: "All good.",
    ...extra,
  };
}

/** @param {World} w @returns {void} */
function current(w) {
  setCurrentRevision({
    revision: approvedOf(w),
    baseSha: TARGET_SHA,
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

export { approvedOf, current, request };
