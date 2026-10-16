// @ts-check
// The claim op for a stacked issue (#268): an issue with no branch of its own
// that starts on its prerequisite's branch, asked for by the claim's stackOn
// or named by the saved state's stackedOn.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { issueReply, LANE, LAPSED, LIVE } from "./ops-claim-test-kit.mjs";
import {
  askOps,
  claimComment,
  commentsReply,
  reply,
  root,
  sh,
  stateComment,
  worktree,
} from "./ops-cli-test-kit.mjs";

/** @import { GhReply } from "./fake-gh.mjs" */

// The prerequisite with a branch, each test's dependent issue and its claim
// comment's id, the mid-stage issue's state comment, and an issue with no
// branch on GitHub.
const PREREQ = 60;
const FRESH = 61;
const FRESH_CLAIM = 110;
const MID_STAGE = 62;
const MID_STAGE_CLAIM = 111;
const MID_STAGE_STATE = 112;
const MISSING = 63;
const MISSING_PREREQ = 69;
const MISSING_CLAIM = 113;
const NAMES_MISSING_PREREQ = /#69\b/u;

// The part of a claim's reply these tests read.
const CLAIM_REPLY = z.looseObject({
  ok: z.unknown(),
  error: z.string().optional(),
  state: z.looseObject({ stackedOn: z.unknown() }).optional(),
});

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

// Pushes a new commit to issue `n`'s branch on origin, cut from the base the
// first time; returns its head.
/** @param {number} n @returns {string} */
function pushBranch(n) {
  sh(
    `cd ${root}/seed && (git checkout -q agent/issue-${n} 2>/dev/null || git checkout -qb agent/issue-${n} integration) && echo ${n} >> prereq-${n} && git add prereq-${n} && git commit -qm "prereq ${n}" && git push -q origin agent/issue-${n}`,
  );
  return sh(`git -C ${root}/seed rev-parse HEAD`);
}

// Claims issue `n` with `stackOn`, the issue's comments being `comments`.
/** @param {number} n @param {{ claimId: number, comments: readonly unknown[], stackOn?: number }} claim @returns {z.infer<typeof CLAIM_REPLY>} */
function claimStacked(n, { claimId, comments, stackOn }) {
  const mine = claimComment(claimId, "me", "s0", LIVE);
  /** @type {GhReply[]} */
  const replies = [
    issueReply(n),
    commentsReply(n, comments),
    { when: `issues/${n}/comments -f`, stdout: JSON.stringify(mine) },
    { ...commentsReply(n, [mine, ...comments]), keep: true },
  ];
  reply(replies);
  const request = { op: "claim", number: n, ...LANE };
  if (stackOn !== undefined) {
    return CLAIM_REPLY.parse(askOps({ ...request, stackOn }));
  }
  return CLAIM_REPLY.parse(askOps(request));
}

/** @param {number} n @returns {string} */
function worktreeHead(n) {
  return sh(`git -C ${worktree(n)} rev-parse HEAD`);
}

const prereqHead = pushBranch(PREREQ);

test("a claim with stackOn starts the worktree at the prerequisite's head and saves stackedOn", () => {
  const claimed = claimStacked(FRESH, {
    claimId: FRESH_CLAIM,
    comments: [],
    stackOn: PREREQ,
  });
  assert.equal(claimed.ok, true);
  const stackedOn = { issue: PREREQ, headSha: prereqHead };
  assert.deepEqual(claimed.state?.stackedOn, stackedOn);
  assert.equal(worktreeHead(FRESH), prereqHead);
  assert.equal(
    sh(`git -C ${worktree(FRESH)} rev-parse --abbrev-ref HEAD`),
    `agent/issue-${FRESH}`,
  );
});

test("a mid-stage claim of a stacked issue moves a worktree at the base to the prerequisite's head", () => {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-${MID_STAGE} ${worktree(MID_STAGE)} origin/integration`,
  );
  const base = worktreeHead(MID_STAGE);
  // The prerequisite moved since the state was saved.
  const moved = pushBranch(PREREQ);
  const state = stateComment(MID_STAGE_STATE, {
    stage: "implement",
    lease: { lane: "other", sweepId: "s0", at: LAPSED },
    pr: null,
    stackedOn: { issue: PREREQ, headSha: base },
  });
  const claimed = claimStacked(MID_STAGE, {
    claimId: MID_STAGE_CLAIM,
    comments: [state],
  });
  assert.equal(claimed.ok, true);
  const stackedOn = { issue: PREREQ, headSha: moved };
  assert.deepEqual(claimed.state?.stackedOn, stackedOn);
  assert.equal(worktreeHead(MID_STAGE), moved);
});

test("a stacked claim fails when the prerequisite has no branch", () => {
  const claimed = claimStacked(MISSING, {
    claimId: MISSING_CLAIM,
    comments: [],
    stackOn: MISSING_PREREQ,
  });
  assert.equal(claimed.ok, false);
  assert.match(claimed.error ?? "", NAMES_MISSING_PREREQ);
});
