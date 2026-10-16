// @ts-check
// The split op through the ops CLI: it opens ordered sub-issues under the
// parent, links them, and parks the parent, as its reply and its GitHub
// writes show.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { bodyOf, effectNames, stateOf } from "./gh-effects.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  effects,
  reply,
  root,
  sh,
  worktree,
} from "./ops-cli-test-kit.mjs";

const LIVE = new Date().toISOString();
const TRIAGER = { role: "triage", agent: "triager" };
const CLAIM_CLOSED = "<!-- agent-pipeline:claim-closed lane=me sweep=s1 -->";
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

// What split shows on GitHub for SPLIT, as effectNames names it.
/** @returns {string[]} */
function splitEffects() {
  const { n, claim, first, second } = SPLIT;
  return [
    `comment #${n} role=triage`,
    `comment #${n} state`,
    `edit comment ${claim} role=claim`,
    "issue A",
    "issue B",
    `label #${n} agent:split`,
    `sub-issue #${n} id ${first.id}`,
    `sub-issue #${n} id ${second.id}`,
    `unlabel #${n} agent:working`,
  ];
}

const BODY_A = "Body of sub-issue A";
const BODY_B = "Body of sub-issue B";

test("split opens ordered sub-issues under the parent and parks it", () => {
  const { n, claim, depth, first, second } = SPLIT;
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${worktree(n)} origin/integration`,
  );
  reply([
    { when: "title=A", stdout: JSON.stringify(first) },
    { when: "title=B", stdout: JSON.stringify(second) },
    { ...commentsReply(n, [myClaim(claim)]), keep: true },
  ]);
  const subIssues = [
    { title: "A", body: BODY_A },
    { title: "B", body: BODY_B, after: [0] },
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
  const split = effects();
  assert.deepEqual(effectNames(split), splitEffects());
  const parentMark = `<!-- agent-pipeline:parent ${n} depth 2 -->`;
  const afterFirst = `<!-- agent-pipeline:after ${first.number} -->`;
  const [a, b] = [bodyOf(split, "issue A"), bodyOf(split, "issue B")];
  assert.ok(a.includes(BODY_A) && !a.includes(BODY_B));
  assert.ok(a.includes(parentMark) && !a.includes(afterFirst));
  assert.ok(b.includes(BODY_B) && !b.includes(BODY_A));
  assert.ok(b.includes(parentMark) && b.includes(afterFirst));
  const note = bodyOf(split, `comment #${n} role=triage`);
  assert.ok(note.includes(`#${first.number}, #${second.number}`));
  assert.deepEqual(stateOf(split, `comment #${n} state`), {
    stage: "split",
    depth,
    lease: null,
    subIssues: [first.number, second.number],
  });
  assert.ok(
    bodyOf(split, `edit comment ${claim} role=claim`).includes(CLAIM_CLOSED),
  );
  assert.equal(fs.existsSync(worktree(n)), false);
});
