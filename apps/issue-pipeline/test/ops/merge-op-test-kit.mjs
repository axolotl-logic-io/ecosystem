// @ts-check
// Requests and matching revision observations for the merge op's real worlds.
import { setCurrentRevision } from "./fake-ops-publish-revision.mjs";
import { boundState, ISSUE, PR, sh } from "./ops-publish-test-kit.mjs";

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
    state: boundState(w, approved),
    expectedSha: w.sha,
    expectedBase: sh(`git -C ${w.worktree} rev-parse origin/integration`),
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
    baseSha: sh(`git -C ${w.worktree} rev-parse origin/integration`),
    pr: { number: PR, state: "OPEN", mergeCommit: null, headSha: w.sha },
  });
}

export { approvedOf, current, request };
