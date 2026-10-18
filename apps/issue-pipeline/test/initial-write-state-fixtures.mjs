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
    persistState: true,
  };
}

/** @param {number} number @param {number} pr @returns {import("./fake-gh.mjs").GhReply} */
function savedDraftReply(number, pr) {
  const reply = initialWriteStateReply(number);
  const comment = JSON.parse(reply.stdout ?? "{}");
  const state = stateAt("implement", {
    number,
    branch: `agent/issue-${number}`,
    lease: null,
    pr,
  });
  comment.body = `<!-- agent-pipeline:state\n${JSON.stringify(state)}\n-->`;
  return { ...reply, stdout: JSON.stringify(comment) };
}

/** @param {number} number @param {number[]} [prs] @param {string} [branch] @returns {import("./fake-gh.mjs").GhReply} */
function historyReply(number, prs = [], branch = `agent/issue-${number}`) {
  return {
    when: `--head ${branch} --state all`,
    stdout: JSON.stringify(prs.map((pr) => ({ number: pr }))),
    keep: true,
  };
}

/** @param {number} number @param {number} pr @param {string} origin @returns {import("./fake-gh.mjs").GhReply & { stdout: string }} */
function openDraftReply(number, pr, origin) {
  return {
    when: `pr view ${pr} `,
    stdout: JSON.stringify({
      number: pr,
      state: "OPEN",
      headRefName: `agent/issue-${number}`,
      headRefOid: "",
      baseRefName: "integration",
      isCrossRepository: false,
      mergeCommit: null,
    }),
    headRef: { repo: origin, ref: `refs/heads/agent/issue-${number}` },
    keep: true,
  };
}

export {
  historyReply,
  initialWriteStateReply,
  openDraftReply,
  savedDraftReply,
};
