// @ts-check
// Only currentRevision is doubled. Graph gates retain real fresh PR and
// ancestry evidence, loaded after the shared fixture establishes HOME/root.
import "./ops-publish-environment.mjs";
import { z } from "zod";

const OBSERVED = z.object({
  mergeAttempt: z.object({ result: z.string() }),
  codeMerged: z.object({ pr: z.number(), sha: z.string() }),
});

const { confirmMerged, pullRequest } = await import("../src/revision.ts");

/**
 * @typedef {import("../src/state.ts").Revision} Revision
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
 * @param {import("../src/config.ts").Config} cfg
 * @param {number} n
 * @param {unknown} state
 * @returns {CurrentRevision}
 */
function currentRevision(cfg, n, state) {
  seen.push({ n, state });
  if (answer === null) {
    throw new Error("the test set no current revision");
  }
  if (answer instanceof Error) {
    throw answer;
  }
  const observed = OBSERVED.safeParse(state);
  if (observed.success) {
    const pr = pullRequest(cfg, n, observed.data.codeMerged.pr);
    return {
      ...answer,
      pr,
      baseSha: observed.data.codeMerged.sha,
      revision: { ...answer.revision, code: observed.data.codeMerged.sha },
    };
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
