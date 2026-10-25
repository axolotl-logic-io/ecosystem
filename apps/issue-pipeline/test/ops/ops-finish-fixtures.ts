// Explicit supported cleanup replies for an open code issue with PR50.

import type { GhReply } from "../fake-gh.ts";
import { commentWriteReplies, labelReplies } from "../gh-mutation-fixtures.ts";

const REPO = "o/r";
const ISSUE = 7;
const PR = 50;

function finishReplies(branch = "agent/issue-7"): GhReply[] {
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
