// @ts-check
// The adoption tests' issues (test/ops-claim-adopt.test.mjs): an issue saved
// as a version 2 state with its worktree on the base and a branch on GitHub
// one commit past the saved head, the push record the ops write before a
// push, and a claim of the issue from its saved state, as ops' claim answers
// it.
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

const { newIssueState } = await import("../src/state.ts");

/** @import { IssueState } from "../src/state.ts" */

// How much of a head an adoption's log line names.
const SHORT_SHA = 8;
// Each issue's claim comment id; its state comment follows it.
const CLAIM_IDS = 10;

const ADOPTED_LOG = /adopted/u;
// The state's log, which records an adopted push.
const LOGGED = z.looseObject({ log: z.array(z.string()) });

// The part of a claim's reply these tests read.
const CLAIM_REPLY = z.looseObject({
  state: z.unknown(),
  remoteHead: z.unknown(),
  branchChanged: z.unknown().optional(),
});

// The clone a sweep used to make, which a claim reads.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Issue `n`, saved at implement with its worktree on the base, and a branch
// on GitHub one commit past the saved head. Returns the saved state and the
// branch's head.
/** @param {number} n @returns {{ saved: IssueState & { headSha: string }, remote: string }} */
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
  const saved = {
    ...newIssueState(n),
    stage: /** @type {const} */ ("implement"),
    headSha: old,
  };
  return { saved, remote };
}

// Records, as the ops would before a push, that `sha` was pushed for `n`.
/** @param {number} n @param {string} sha @param {string} [op] @returns {void} */
function recordPush(n, sha, op = "sync-base") {
  fs.mkdirSync(runDir(n), { recursive: true });
  const record = JSON.stringify({ sha, op, at: TIME });
  fs.writeFileSync(path.join(runDir(n), "pushed.json"), record);
}

// Issue `n`'s comments when this lane holds it, saved as `saved`.
/** @param {number} n @param {object} saved @returns {object[]} */
function heldComments(n, saved) {
  return [
    claimComment(n * CLAIM_IDS, LANE.lane, LANE.sweepId, LIVE),
    stateComment(n * CLAIM_IDS + 1, saved),
  ];
}

// Claims `n`, which this lane already holds, from the saved state `saved`.
// Returns ops' whole reply, with the parts these tests read checked.
/** @param {number} n @param {object} saved @returns {z.infer<typeof CLAIM_REPLY>} */
function claimSaved(n, saved) {
  const comments = heldComments(n, saved);
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
  heldComments,
  LOGGED,
  movedBranch,
  recordPush,
  SHORT_SHA,
};
