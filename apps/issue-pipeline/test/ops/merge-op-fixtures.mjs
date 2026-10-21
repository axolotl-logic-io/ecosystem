// @ts-check
// Supported exact POST and signed merge-comment effects for the strict op fixture.
import path from "node:path";

const REPO = "o/r";

/** @typedef {import("./ops-publish-test-kit.mjs").World} World */
/** @typedef {import("../fake-gh.mjs").GhReply} GhReply */

// The exact explicit-target POST applies a prepared genuine [P,H] result.
/** @param {Pick<World, "root" | "sha" | "mergeSha">} w @returns {GhReply} */
function branchMergeReply(w) {
  return {
    when: `api repos/${REPO}/merges --method POST --include -f base=integration -f head=${w.sha}`,
    stdout: `HTTP/2.0 201 Created\r\n\r\n${JSON.stringify({ sha: w.mergeSha })}`,
    branchMerge: {
      origin: path.join(w.root, "origin.git"),
      base: "integration",
      head: w.sha,
      sha: w.mergeSha,
    },
  };
}

/** @returns {GhReply[]} */
function mergeCommentReplies() {
  return [
    { when: "issues/50/comments?per_page", stdout: "", keep: true },
    {
      when: "api -X POST repos/o/r/issues/50/comments -f",
      stdout: "",
      keep: true,
    },
  ];
}

/** @param {{ sha: string }} w @returns {GhReply} */
function approvalReply(w) {
  return {
    when: `api repos/${REPO}/pulls/50/reviews --method POST -f event=APPROVE -f commit_id=${w.sha} --jq {state, commit: .commit_id, login: .user.login}`,
    stdout: JSON.stringify({
      state: "APPROVED",
      commit: w.sha,
      login: "bot",
    }),
  };
}

export { approvalReply, branchMergeReply, mergeCommentReplies };
