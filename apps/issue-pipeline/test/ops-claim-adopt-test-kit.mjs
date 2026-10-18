// @ts-check
// The adoption tests' issues (test/ops-claim-adopt*.test.mjs): an issue saved
// with its worktree on the base and a branch on GitHub one commit past the
// saved head, the push record the ops write before a push, and a claim of the
// issue from its saved state, as ops' claim answers it.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { issueReply, LANE, LIVE } from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

// How much of a head an adoption's log line names.
const SHORT_SHA = 8;
// Each issue's claim comment id; its state comment follows it.
const CLAIM_IDS = 10;

/**
 * A state saved at checks, as movedBranch saves it, with any other fields a
 * test adds.
 * @typedef {{ stage: string, lease: null, pr: null, headSha: string, passedSha: string | null, log: string[], [field: string]: unknown }} Saved
 */

const ADOPTED_LOG = /adopted/u;
// The state's log, which records an adopted push.
const LOGGED = z.looseObject({ log: z.array(z.string()) });

// The part of a claim's reply these tests read.
const CLAIM_REPLY = z.looseObject({
  state: z.unknown(),
  remoteHead: z.unknown(),
});

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Issue `n`, saved at checks with its worktree on the base, and a branch on
// GitHub one commit past the saved head. Returns the saved state and the
// branch's head.
/** @param {number} n @returns {{ saved: Saved, remote: string }} */
function movedBranch(n) {
  const wt = worktree(n);
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${n} ${wt} origin/integration`,
  );
  const old = sh(`git -C ${wt} rev-parse HEAD`);
  sh(
    `cd ${root}/seed && git checkout -qb agent/issue-${n} integration && echo ${n} > a${n} && git add a${n} && git commit -qm work && git push -q origin agent/issue-${n}`,
  );
  const remote = sh(`git -C ${root}/seed rev-parse HEAD`);
  /** @type {Saved} */
  const saved = {
    stage: "checks",
    lease: null,
    pr: null,
    headSha: old,
    passedSha: old,
    log: [],
  };
  return { saved, remote };
}

// Records, as the ops would before a push, that `sha` was pushed for `n`.
/** @param {number} n @param {string} sha @param {string} [op] @returns {void} */
function recordPush(n, sha, op = "finish-sync") {
  fs.mkdirSync(runDir(n), { recursive: true });
  const record = JSON.stringify({ sha, op, at: TIME });
  fs.writeFileSync(path.join(runDir(n), "pushed.json"), record);
}

// Claims `n`, which this lane already holds, from the saved state `saved`.
// Returns ops' whole reply, with the parts these tests read checked.
/** @param {number} n @param {object} saved @returns {z.infer<typeof CLAIM_REPLY>} */
function claimSaved(n, saved) {
  const comments = [
    claimComment(n * CLAIM_IDS, "me", "s0", LIVE),
    stateComment(n * CLAIM_IDS + 1, saved),
  ];
  reply([
    issueReply(n),
    commentsReply(n, comments),
    commentsReply(n, comments),
  ]);
  return CLAIM_REPLY.parse(askOps({ op: "claim", number: n, ...LANE }));
}

// The head of issue `n`'s worktree.
/** @param {number} n @returns {string} */
function head(n) {
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

export {
  ADOPTED_LOG,
  CLAIM_IDS,
  claimSaved,
  head,
  LOGGED,
  movedBranch,
  recordPush,
  SHORT_SHA,
};
