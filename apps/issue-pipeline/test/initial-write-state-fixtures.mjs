// @ts-check
// A saved initial premerge state, before a caller records a PR or any merge.
// Never derive receipts from a request or mutable remote head. Tests needing
// later authority must serve their actual saved state instead.
import { commentLines, githubComment } from "./fake-gh.mjs";
import { stateAt } from "./job-fixtures.mjs";

/** @param {number} number @param {string} [branch] @returns {import("./fake-gh.mjs").GhReply} */
function initialWriteStateReply(number, branch = `agent/issue-${number}`) {
  const state = stateAt("implement", { number, branch, lease: null });
  const comment = githubComment({
    id: number,
    login: "a",
    created: "2026-10-18T00:00:00Z",
    body: `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`,
  });
  return {
    when: `issues/${number}/comments`,
    stdout: commentLines([comment]),
    keep: true,
  };
}

export { initialWriteStateReply };
