// The adoption tests' issues (test/ops/ops-claim-adopt.test.ts): an issue saved
// as a version 2 state with its worktree on the base and a branch on GitHub
// one commit past the saved head, the push record the ops write before a
// push, and a claim of the issue from its saved state, as ops' claim answers
// it.

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { IssueState } from "../../src/state.ts";
import { RELEASED_RECEIPT } from "../fake-ownership.ts";
import { claimMutationReplies } from "../gh-mutation-fixtures.ts";
import { historyReply } from "../initial-write-state-fixtures.ts";
import { issueReply, LANE, LIVE } from "../ops-claim-test-kit.ts";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  requireGhReplies,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
} from "../ops-cli-test-kit.ts";

requireGhReplies();

const { newIssueState }: typeof import("../../src/state.ts") = await import(
  "../../src/state.ts"
);

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
function movedBranch(n: number): {
  saved: IssueState & { headSha: string };
  remote: string;
} {
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
    stage: "implement" as const,
    headSha: old,
  };
  return { saved, remote };
}

// Records, as the ops would before a push, that `sha` was pushed for `n`.
function recordPush(n: number, sha: string, op = "sync-base"): void {
  fs.mkdirSync(runDir(n), { recursive: true });
  const record = JSON.stringify({ sha, op, at: TIME });
  fs.writeFileSync(path.join(runDir(n), "pushed.json"), record);
}

// Issue `n`'s comments when this lane holds it, saved as `saved`.
function heldComments(n: number, saved: object): object[] {
  return [
    claimComment(n * CLAIM_IDS, LANE.lane, LANE.sweepId, LIVE),
    stateComment(n * CLAIM_IDS + 1, { ...saved, execution: RELEASED_RECEIPT }),
  ];
}

// Claims `n`, which this lane already holds, from the saved state `saved`.
// Returns ops' whole reply, with the parts these tests read checked.
function claimSaved(n: number, saved: object): z.infer<typeof CLAIM_REPLY> {
  const comments = heldComments(n, saved);
  reply([
    historyReply(n),
    issueReply(n),
    commentsReply(n, comments),
    commentsReply(n, comments),
    ...claimMutationReplies(n, n * CLAIM_IDS + 1, null),
  ]);
  return CLAIM_REPLY.parse(askOps({ op: "claim", number: n, ...LANE }));
}

// The head of issue `n`'s worktree.
function head(n: number): string {
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
