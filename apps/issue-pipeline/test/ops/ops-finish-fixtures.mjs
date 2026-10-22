// @ts-check
// Explicit supported cleanup replies for an open code issue with PR50.
import { commentWriteReplies, labelReplies } from "../gh-mutation-fixtures.mjs";

const REPO = "o/r";
const ISSUE = 7;
const PR = 50;

/** @param {string} [branch] @returns {import("../fake-gh.mjs").GhReply[]} */
function finishReplies(branch = "agent/issue-7") {
  return [
    {
      when: `api -X DELETE repos/${REPO}/git/refs/heads/${branch} --silent`,
      stdout: "",
    },
    ...[PR, ISSUE].flatMap((target) =>
      labelReplies(REPO, target, ["agent:merged"], ["agent:working"]),
    ),
    ...commentWriteReplies(REPO, ISSUE, []),
    {
      when: `repos/${REPO}/issues/${ISSUE} --jq {state}`,
      stdout: '{"state":"open"}',
    },
    {
      when: `issue close ${ISSUE} -R ${REPO} --reason completed --comment`,
      stdout: "",
    },
  ];
}

export { finishReplies };
