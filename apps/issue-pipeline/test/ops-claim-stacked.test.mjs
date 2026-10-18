// @ts-check
// The claim op for a stacked issue (#268): an issue with no branch of its own
// that starts on its prerequisite's branch, asked for by the claim's stackOn
// or named by the saved state's stackedOn, or on the base once that
// prerequisite has merged.
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
// Issues stacked on a prerequisite that has merged: one whose branch was
// deleted, and one whose branch is still on GitHub.
const UNSTACKED = 64;
const UNSTACKED_CLAIM = 114;
const UNSTACKED_STATE = 115;
const DELETED_PREREQ = 70;
const UNSTACKED_KEPT = 65;
const UNSTACKED_KEPT_CLAIM = 116;
const UNSTACKED_KEPT_STATE = 117;
const KEPT_PREREQ = 71;
const MERGED_PR = 500;

// The part of a claim's reply these tests read.
const CLAIM_REPLY = z.looseObject({
  ok: z.unknown(),
  error: z.string().optional(),
  state: z
    .looseObject({
      stackedOn: z.unknown(),
      log: z.array(z.unknown()).optional(),
    })
    .optional(),
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

// Claims issue `n` with `stackOn`, the issue's comments being `comments`,
// and gh giving the `prereq` replies too.
/** @param {number} n @param {{ claimId: number, comments: readonly unknown[], stackOn?: number, prereq?: readonly GhReply[] }} claim @returns {z.infer<typeof CLAIM_REPLY>} */
function claimStacked(n, { claimId, comments, stackOn, prereq = [] }) {
  const mine = claimComment(claimId, "me", "s0", LIVE);
  /** @type {GhReply[]} */
  const replies = [
    issueReply(n),
    commentsReply(n, comments),
    { when: `issues/${n}/comments -f`, stdout: JSON.stringify(mine) },
    { ...commentsReply(n, [mine, ...comments]), keep: true },
    ...prereq,
  ];
  reply(replies);
  const request = { op: "claim", number: n, ...LANE };
  if (stackOn !== undefined) {
    return CLAIM_REPLY.parse(askOps({ ...request, stackOn }));
  }
  return CLAIM_REPLY.parse(askOps(request));
}

// The base's head on GitHub.
function baseHead() {
  return sh(`git --git-dir ${root}/origin.git rev-parse integration`);
}

// The mid-stage state of an issue stacked on `prereq` at `headSha`.
/** @param {number} id @param {number} prereq @param {string} headSha @returns {object} */
function stackedState(id, prereq, headSha) {
  return stateComment(id, {
    stage: "spec",
    lease: { lane: "other", sweepId: "s0", at: LAPSED },
    pr: null,
    stackedOn: { issue: prereq, headSha },
  });
}

/** @param {readonly unknown[] | undefined} log @param {number} prereq @returns {boolean} */
function logsUnstack(log, prereq) {
  const line = new RegExp(
    `unstacked from #${prereq}, which has merged; starts from origin/integration$`,
    "u",
  );
  return (log ?? []).some((entry) => line.test(String(entry)));
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

test("a claim of an issue stacked on a merged prerequisite with no branch unstacks it and starts from the base", () => {
  const base = baseHead();
  const claimed = claimStacked(UNSTACKED, {
    claimId: UNSTACKED_CLAIM,
    comments: [stackedState(UNSTACKED_STATE, DELETED_PREREQ, base)],
    prereq: [
      {
        when: `--head agent/issue-${DELETED_PREREQ} --state merged`,
        stdout: JSON.stringify([{ number: MERGED_PR, mergeCommit: null }]),
        keep: true,
      },
    ],
  });
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.state?.stackedOn, null);
  assert.ok(logsUnstack(claimed.state?.log, DELETED_PREREQ));
  assert.equal(worktreeHead(UNSTACKED), base);
});

test("a claim of an issue stacked on a merged prerequisite whose branch remains moves its worktree to the base", () => {
  const prereqAt = pushBranch(KEPT_PREREQ);
  const clone = `${root}/clones/o__r`;
  const branch = `agent/issue-${KEPT_PREREQ}`;
  sh(
    `git -C ${clone} fetch -q origin ${branch}:refs/remotes/origin/${branch} && git -C ${clone} worktree add -q -B agent/issue-${UNSTACKED_KEPT} ${worktree(UNSTACKED_KEPT)} ${prereqAt}`,
  );
  const claimed = claimStacked(UNSTACKED_KEPT, {
    claimId: UNSTACKED_KEPT_CLAIM,
    comments: [stackedState(UNSTACKED_KEPT_STATE, KEPT_PREREQ, prereqAt)],
    prereq: [
      {
        when: `repos/o/r/issues/${KEPT_PREREQ} --jq`,
        stdout: JSON.stringify({ state: "closed", reason: "completed" }),
        keep: true,
      },
    ],
  });
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.state?.stackedOn, null);
  assert.ok(logsUnstack(claimed.state?.log, KEPT_PREREQ));
  assert.equal(worktreeHead(UNSTACKED_KEPT), baseHead());
});
