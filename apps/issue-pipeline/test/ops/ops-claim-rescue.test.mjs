// @ts-check
// The claim op's move of a worktree to the pipeline's own push it adopts,
// when the worktree's head has commits the issue's branch on GitHub lacks:
// they are saved under refs/pipeline/rescue/<n>/<stamp>, and HEAD is kept,
// or reset to the branch when the push and the worktree diverged (#283). A
// claim adopts nothing else (ops-claim-provenance.test.mjs), so it moves no
// other worktree.

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import { requireGhReplies } from "../ops-cli-test-kit.mjs";
import {
  everyCommentsRead,
  kit,
  LANE,
  myClaim,
  openIssue,
  recordPipelinePush,
  v2State,
} from "../ops-v2-test-kit.mjs";

requireGhReplies();

const { askOps, reply, root, sh, savedStateComment, worktree } = kit;

const COMMITTER = "-c user.email=a@b -c user.name=a";
const CLONE = `${root}/clones/o__r`;
// The issue whose worktree is ahead of the adopted push, the one whose
// worktree and the adopted push diverged, and the one approved at merge.
const AHEAD = 70;
const DIVERGED = 71;
const REVIEWED = 72;
const STATE_ID = 1;
const CLAIM_ID = 2;

// The part of a claim's reply these tests read.
const CLAIMED = z.looseObject({
  ok: z.literal(true),
  state: z.looseObject({
    stage: z.string(),
    headSha: z.string().nullable(),
    review: z.looseObject({ verdict: z.string().nullable() }),
    log: z.array(z.string()),
  }),
});

// Pushes a commit to issue `n`'s branch on origin; returns its head.
/** @param {number} n @returns {string} */
function pushToBranch(n) {
  sh(
    `cd ${root}/seed && (git checkout -q agent/issue-${n} 2>/dev/null || git checkout -qb agent/issue-${n} integration)`,
  );
  sh(
    `cd ${root}/seed && echo x >> b-${n} && git add b-${n} && git commit -qm branch && git push -q origin HEAD:refs/heads/agent/issue-${n}`,
  );
  return sh(`git -C ${root}/seed rev-parse HEAD`);
}

// Gives issue `n` a branch on origin and a worktree with one commit on top
// of it. Returns the branch's head and the worktree's.
/** @param {number} n @returns {{ branch: string, local: string }} */
function worktreeAheadOfBranch(n) {
  const branch = pushToBranch(n);
  sh(`git -C ${CLONE} fetch -q origin`);
  sh(
    `git -C ${CLONE} worktree add -q -B agent/issue-${n} ${worktree(n)} origin/agent/issue-${n}`,
  );
  sh(
    `cd ${worktree(n)} && echo mine > mine && git add mine && git ${COMMITTER} commit -qm mine`,
  );
  return { branch, local: sh(`git -C ${worktree(n)} rev-parse HEAD`) };
}

// The rescue refs of issue `n`, as `<sha> <ref>` lines.
/** @param {number} n @returns {string[]} */
function rescueRefs(n) {
  const listed = sh(
    `git -C ${worktree(n)} for-each-ref --format='%(objectname) %(refname)' refs/pipeline/rescue/${n}/`,
  );
  return listed.split("\n").filter((line) => line !== "");
}

// Claims issue `n`, which this lane holds, saved as `saved`.
/** @param {number} n @param {object} saved */
function claimSaved(n, saved) {
  reply([
    historyReply(n),
    openIssue(n),
    everyCommentsRead(n, [
      savedStateComment(STATE_ID, saved),
      myClaim(CLAIM_ID),
    ]),
    ...claimMutationReplies(n, STATE_ID, null),
  ]);
  return CLAIMED.parse(askOps({ op: "claim", number: n, ...LANE })).state;
}

// What issue `n`'s rescue refs saved, and whether `log` names each of them.
/** @param {number} n @param {readonly string[]} log @returns {{ saved: string[], named: boolean }} */
function rescued(n, log) {
  const refs = rescueRefs(n).map((line) => line.split(" "));
  return {
    saved: refs.map(([sha]) => String(sha)),
    named: refs.every(([, ref]) =>
      log.some((line) => line.includes(String(ref))),
    ),
  };
}

test("a claim that adopts a push keeps a worktree ahead of it and saves a rescue ref", () => {
  const base = sh(`git -C ${root}/seed rev-parse integration`);
  const { branch, local } = worktreeAheadOfBranch(AHEAD);
  recordPipelinePush(AHEAD, branch, "push");
  const state = claimSaved(AHEAD, v2State(AHEAD, { headSha: base }));
  assert.equal(state.headSha, branch);
  assert.equal(sh(`git -C ${worktree(AHEAD)} rev-parse HEAD`), local);
  assert.deepEqual(rescued(AHEAD, state.log), { saved: [local], named: true });
});

test("a claim resets a worktree that diverged from the push it adopts, keeping a rescue ref", () => {
  const { branch, local } = worktreeAheadOfBranch(DIVERGED);
  const pushed = pushToBranch(DIVERGED);
  recordPipelinePush(DIVERGED, pushed, "push");
  const state = claimSaved(DIVERGED, v2State(DIVERGED, { headSha: branch }));
  assert.equal(state.headSha, pushed);
  assert.equal(sh(`git -C ${worktree(DIVERGED)} rev-parse HEAD`), pushed);
  assert.deepEqual(rescued(DIVERGED, state.log), {
    saved: [local],
    named: true,
  });
});

test("a claim that adopts a push past an approval sends it back to review, keeping unpushed commits", () => {
  const base = sh(`git -C ${root}/seed rev-parse integration`);
  const { branch, local } = worktreeAheadOfBranch(REVIEWED);
  recordPipelinePush(REVIEWED, branch, "push");
  const approved = v2State(REVIEWED, {
    stage: "merge",
    headSha: base,
    review: {
      round: 1,
      verdict: "approve",
      commentId: null,
      findings: [],
      revision: null,
    },
  });
  const state = claimSaved(REVIEWED, approved);
  assert.equal(state.stage, "review");
  assert.equal(state.review.verdict, null);
  assert.deepEqual(rescued(REVIEWED, state.log), {
    saved: [local],
    named: true,
  });
});
