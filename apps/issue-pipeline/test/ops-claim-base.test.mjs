// The claim op's reset, at a start, of a worktree whose issue has no branch
// on GitHub: one with no commits of its own moves to the fetched base, and
// one with commits past the base is kept (#243).
import assert from "node:assert/strict";
import { test } from "node:test";
import { issueReply, LANE, LIVE } from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  root,
  sh,
  worktree,
} from "./ops-cli-test-kit.mjs";

const COMMITTER = "-c user.email=a@b -c user.name=a";
// The issue whose worktree has no commits of its own, the one whose worktree
// has, and the ids of their claim comments.
const BARE = 46;
const OWN = 48;
const BARE_CLAIM = 102;
const OWN_CLAIM = 103;

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Adds issue `n`'s worktree at the base, then moves the base on GitHub, with
// no branch for the issue there. Returns the base's new head.
/** @param {number} n @returns {string} */
function worktreeBehindBase(n) {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${worktree(n)} origin/integration`,
  );
  sh(
    `cd ${root}/seed && git checkout -q integration && echo ${n} > base-${n} && git add base-${n} && git commit -qm "base moves" && git push -q origin integration`,
  );
  return sh(`git -C ${root}/seed rev-parse HEAD`);
}

// Claims the unlabelled, unclaimed issue `n` as new work.
/** @param {number} n @param {number} claimId @returns {{ ok?: unknown }} */
function claimNew(n, claimId) {
  const mine = claimComment(claimId, "me", "s0", LIVE);
  reply([
    issueReply(n),
    commentsReply(n, []),
    { when: `issues/${n}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(n, [mine]),
  ]);
  return askOps({ op: "claim", number: n, ...LANE });
}

test("a claim resets a worktree with no work of its own to the moved base", () => {
  const base = worktreeBehindBase(BARE);
  sh(`echo stray > ${worktree(BARE)}/stray`);
  assert.equal(claimNew(BARE, BARE_CLAIM).ok, true);
  assert.equal(sh(`git -C ${worktree(BARE)} rev-parse HEAD`), base);
  assert.equal(sh(`git -C ${worktree(BARE)} status --porcelain`), "");
});

test("a claim keeps a worktree that has commits past the base", () => {
  worktreeBehindBase(OWN);
  sh(
    `cd ${worktree(OWN)} && echo mine > mine && git add mine && git ${COMMITTER} commit -qm mine`,
  );
  const own = sh(`git -C ${worktree(OWN)} rev-parse HEAD`);
  assert.equal(claimNew(OWN, OWN_CLAIM).ok, true);
  assert.equal(sh(`git -C ${worktree(OWN)} rev-parse HEAD`), own);
});
