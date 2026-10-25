// The claim op never drops a lane worktree's commits: a worktree whose issue
// has no branch on GitHub, with commits past the base, is kept (#243). The
// claim no longer moves a worktree to a moved base: stage jobs work in their
// own checkout, cloned from the freshly fetched mirror at every start
// (src/job/checkout.ts openJobCheckout; pr-ops-job-checkout.test.mjs,
// job-checkout-dropped.test.mjs), and a claim moves a lane worktree only to
// a push of the pipeline's own it adopts (ops-claim-rescue.test.mjs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { claimMutationReplies } from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import { issueReply, LANE, LIVE } from "../ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  requireGhReplies,
  root,
  savedStateComment,
  sh,
  worktree,
} from "../ops-cli-test-kit.mjs";

requireGhReplies();

const { newIssueState } = await import("../../src/state.ts");
const COMMITTER = "-c user.email=a@b -c user.name=a";
// The issue whose worktree has commits of its own, and its claim comment.
const OWN = 48;
const OWN_CLAIM = 103;

// The clone a sweep used to make, which a claim reads.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Adds issue `n`'s worktree at the base, then moves the base on GitHub, with
// no branch for the issue there.
/** @param {number} n @returns {void} */
function worktreeBehindBase(n) {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${worktree(n)} origin/integration`,
  );
  sh(
    `cd ${root}/seed && git checkout -q integration && echo ${n} > base-${n} && git add base-${n} && git commit -qm "base moves" && git push -q origin integration`,
  );
}

// The part of a claim's reply these tests read.
const CLAIM_REPLY = z.looseObject({ ok: z.unknown() });

// Claims the unlabelled, unclaimed issue `n` as new work.
/** @param {number} n @param {number} claimId @returns {{ ok?: unknown }} */
function claimNew(n, claimId) {
  const mine = claimComment(claimId, "me", "s0", LIVE);
  reply([
    historyReply(n),
    issueReply(n),
    commentsReply(n, [savedStateComment(n, newIssueState(n))]),
    { when: `issues/${n}/comments -f`, stdout: JSON.stringify(mine) },
    {
      ...commentsReply(n, [savedStateComment(n, newIssueState(n)), mine]),
      keep: true,
    },
    ...claimMutationReplies(n, n, null),
  ]);
  return CLAIM_REPLY.parse(askOps({ op: "claim", number: n, ...LANE }));
}

test("a claim keeps a worktree that has commits past the base", () => {
  worktreeBehindBase(OWN);
  sh(
    `cd ${worktree(OWN)} && echo mine > mine && git add mine && git ${COMMITTER} commit -qm mine`,
  );
  const own = sh(`git -C ${worktree(OWN)} rev-parse HEAD`);
  assert.equal(claimNew(OWN, OWN_CLAIM).ok, true);
  assert.equal(sh(`git -C ${worktree(OWN)} rev-parse HEAD`), own);
});
