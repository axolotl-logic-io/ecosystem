// @ts-check
// The split op through the ops CLI, pinned to the reply and gh calls it made
// before it moved to src/ops/ (#183): it opens ordered sub-issues under the
// parent, links them, and parks the parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  askOps,
  calls,
  claimComment,
  closedClaim,
  commentsReply,
  ghCalls,
  reply,
  root,
  sh,
  stateBody,
  worktree,
} from "./ops-cli-test-kit.mjs";

const LIVE = new Date().toISOString();
const TRIAGER = { role: "triage", agent: "triager" };
const TRIAGER_SIGNATURE =
  "**🤖 issue-pipeline · triage**\n<sub>agent `triager`</sub>\n<!-- agent-pipeline:comment role=triage -->";
// The issue split, its claim, and the sub-issues it opens.
const SPLIT = {
  n: 52,
  claim: 7,
  depth: 1,
  first: { id: 900, number: 60 },
  second: { id: 901, number: 61 },
};

sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

/** @param {number} id @returns {object} */
function myClaim(id) {
  return claimComment(id, "me", "s1", LIVE);
}

// The gh call that opens one of split's sub-issues of SPLIT.
/** @param {string} title @param {string} body @param {string} [afterLine] @returns {string[]} */
function openCall(title, body, afterLine = "") {
  const parent = `\n\n<!-- agent-pipeline:parent ${SPLIT.n} depth 2 -->`;
  const text = `${TRIAGER_SIGNATURE}\n\n${body}\n\nPart of #${SPLIT.n}.${afterLine}${parent}`;
  return [
    "api",
    "-X",
    "POST",
    "repos/o/r/issues",
    "-f",
    `title=${title}`,
    "-f",
    `body=${text}`,
  ];
}

// The gh call that links a sub-issue to SPLIT.
/** @param {number} id @returns {string[]} */
function linkCall(id) {
  const endpoint = `repos/o/r/issues/${SPLIT.n}/sub_issues`;
  return [
    "api",
    "-X",
    "POST",
    endpoint,
    "-F",
    `sub_issue_id=${id}`,
    "--silent",
  ];
}

// The calls that open split's two sub-issues of SPLIT, the second after the first.
/** @returns {string[][]} */
function subIssueCalls() {
  const { first, second } = SPLIT;
  const after = `\nAfter #${first.number} merges.\n<!-- agent-pipeline:after ${first.number} -->`;
  return [
    openCall("A", "a"),
    linkCall(first.id),
    openCall("B", "b", after),
    linkCall(second.id),
  ];
}

// Every gh call split makes for SPLIT, after it opens the sub-issues.
/** @returns {string[][]} */
function splitCalls() {
  const { n, claim, depth, first, second } = SPLIT;
  const created = `#${first.number}, #${second.number}`;
  const note = `I split this issue into ${created}. The pipeline closes it when they have all merged.`;
  const subIssues = [first.number, second.number];
  return [
    ...subIssueCalls(),
    ghCalls.post(n, `${TRIAGER_SIGNATURE}\n\n${note}`),
    ghCalls.listComments(n),
    ghCalls.post(
      n,
      stateBody(n, { stage: "split", depth, lease: null, subIssues }),
    ),
    ghCalls.unlabel(n, "agent:working"),
    ghCalls.label(n, "agent:split"),
    ghCalls.listComments(n),
    closedClaim(claim, "the issue was split into sub-issues."),
  ];
}

test("split opens ordered sub-issues under the parent and parks it", () => {
  const { n, claim, depth, first, second } = SPLIT;
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${worktree(n)} origin/integration`,
  );
  reply([
    { when: "title=A", stdout: JSON.stringify(first) },
    { when: "title=B", stdout: JSON.stringify(second) },
    commentsReply(n, []),
    commentsReply(n, [myClaim(claim)]),
  ]);
  const subIssues = [
    { title: "A", body: "a" },
    { title: "B", body: "b", after: [0] },
  ];
  const request = {
    op: "split",
    number: n,
    state: { stage: "triage", depth },
    subIssues,
    by: TRIAGER,
  };
  assert.deepEqual(askOps(request), {
    ok: true,
    op: "split",
    posted: 0,
    created: [first.number, second.number],
  });
  assert.deepEqual(calls(), splitCalls());
  assert.equal(fs.existsSync(worktree(n)), false);
});
