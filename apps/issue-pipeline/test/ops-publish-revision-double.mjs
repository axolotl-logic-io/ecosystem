// @ts-check
// Only currentRevision is doubled. Graph gates retain real fresh PR and
// ancestry evidence, loaded after the shared fixture establishes HOME/root.
import "./ops-publish-environment.mjs";

const { confirmMerged, pullRequest } = await import("../src/revision.ts");

/**
 * @typedef {{ code: string | null, wiki: string | null, inputs: string }} Revision
 * @typedef {{ number: number, state: "OPEN" | "CLOSED" | "MERGED", mergeCommit: string | null, headSha: string }} CurrentPr
 * @typedef {{ revision: Revision, baseSha: string, pr: CurrentPr | null }} CurrentRevision
 */

/** @type {CurrentRevision | Error | null} */
let answer = null;
/** @type {{ n: number, state: unknown }[]} */
const seen = [];

/** @param {CurrentRevision | Error} value @returns {void} */
function setCurrentRevision(value) {
  answer = value;
  seen.length = 0;
}

/** @returns {{ n: number, state: unknown }[]} */
function currentRevisionCalls() {
  return [...seen];
}

/**
 * @param {unknown} _cfg
 * @param {number} n
 * @param {unknown} state
 * @returns {CurrentRevision}
 */
function currentRevision(_cfg, n, state) {
  seen.push({ n, state });
  if (answer === null) {
    throw new Error("the test set no current revision");
  }
  if (answer instanceof Error) {
    throw answer;
  }
  return answer;
}

export {
  confirmMerged,
  currentRevision,
  currentRevisionCalls,
  pullRequest,
  setCurrentRevision,
};
