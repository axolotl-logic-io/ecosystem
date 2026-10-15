// The claim op through the ops CLI, pinned to the replies, gh calls and
// worktrees it made before it moved to src/ops/claim.ts (#183).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  claimReply,
  getIssue,
  issueReply,
  LANE,
  LAPSED,
  LEASE,
  LIVE,
  listOpenPrs,
  NEW_STATE,
  patchState,
  postClaim,
  postState,
} from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  calls,
  claimComment,
  commentsReply,
  configWith,
  ghCalls,
  issueComment,
  reply,
  root,
  runDir,
  sh,
  stateComment,
  TIME,
  worktree,
} from "./ops-cli-test-kit.mjs";

const SETUP_MARK = "setup-ran";
const BEFORE_LAPSED = "2019-01-01T00:00:00Z";

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

test("a claim loses to another lane's live claim", () => {
  reply([
    issueReply(40),
    commentsReply(40, [claimComment(9, "other", "s0", LIVE)]),
  ]);
  assert.deepEqual(askOps({ op: "claim", number: 40, ...LANE }), {
    ok: true,
    op: "claim",
    posted: false,
    lost: true,
    holder: "other",
  });
  assert.deepEqual(calls(), [getIssue(40), ghCalls.listComments(40)]);
});

test("a claim refuses an issue that isn't open", () => {
  reply([issueReply(41, { state: "closed" })]);
  assert.deepEqual(askOps({ op: "claim", number: 41, ...LANE }), {
    ok: false,
    error: "#41 is not open",
  });
  assert.deepEqual(calls(), [getIssue(41), ghCalls.listComments(41)]);
});

test("a claim of new work posts its claim, makes the worktree and runs setup", () => {
  const config = configWith({
    commands: { test: "true", setup: `touch ${SETUP_MARK}` },
  });
  const mine = claimComment(100, "me", "s0", LIVE);
  reply([
    issueReply(42),
    commentsReply(42, []),
    { when: "issues/42/comments -f", stdout: JSON.stringify(mine) },
    commentsReply(42, [mine]),
  ]);
  const state = { ...NEW_STATE, number: 42 };
  assert.deepEqual(
    askOps({ op: "claim", config, number: 42, ...LANE }),
    claimReply(42, {
      state,
      claim: { id: 100, posted: true, waited: 0 },
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(42),
    ghCalls.listComments(42),
    postClaim(42),
    ghCalls.label(42, "agent:working"),
    ghCalls.listComments(42),
    ghCalls.unlabel(42, "agent:needs-info"),
    ghCalls.label(42, "agent:working"),
    ghCalls.listComments(42),
    postState(42, state),
  ]);
  assert.ok(fs.existsSync(path.join(worktree(42), SETUP_MARK)));
  assert.ok(fs.existsSync(path.join(runDir(42), "setup-at-claim.log")));
});

// startState's restart of #43 at review, on its PR's branch at `sha`.
function answeredState(sha) {
  return {
    ...NEW_STATE,
    number: 43,
    stage: "review",
    pr: 50,
    headSha: sha,
    log: [
      `${TIME} restarted on the existing branch (PR #50) at review after answered questions; limits reset`,
    ],
    implemented: true,
  };
}

test("a claim of an answered issue with a PR clears its labels and labels the PR", () => {
  sh(
    `cd ${root}/seed && git checkout -qb agent/issue-43 integration && echo 2 > g && git add g && git commit -qm work && git push -q origin agent/issue-43`,
  );
  const comments = [
    claimComment(10, "me", "s0", LIVE),
    stateComment(11, {
      stage: "triage",
      questionsAt: LAPSED,
      lease: null,
      pr: 50,
    }),
    issueComment(16, "answer", ALLOWED, LIVE),
  ];
  reply([
    issueReply(43, {
      labels: [{ name: "agent:needs-info" }, { name: "agent:stopped-budget" }],
    }),
    commentsReply(43, comments),
    { when: "pr list", stdout: JSON.stringify([{ number: 50 }]) },
    commentsReply(43, comments),
  ]);
  const sha = sh(`git -C ${root}/seed rev-parse HEAD`);
  const state = answeredState(sha);
  assert.deepEqual(
    askOps({ op: "claim", number: 43, ...LANE }),
    claimReply(43, {
      state,
      claim: { id: 10, posted: false },
      remoteHead: sha,
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(43),
    ghCalls.listComments(43),
    ghCalls.collaborator(ALLOWED),
    listOpenPrs(43),
    ghCalls.unlabel(43, "agent:needs-info"),
    ghCalls.unlabel(43, "agent:stopped-budget"),
    ghCalls.label(43, "agent:working"),
    ghCalls.label(50, "agent:working"),
    ["api", "repos/o/r/issues/50/labels"],
    ghCalls.listComments(43),
    patchState(43, 11, state),
  ]);
});

test("a claim of a needs-info issue with no answer waits and changes nothing", () => {
  const comments = [
    stateComment(17, { stage: "triage", questionsAt: LAPSED, pr: null }),
    issueComment(18, "too early", ALLOWED, BEFORE_LAPSED),
  ];
  reply([
    issueReply(47, { labels: [{ name: "agent:needs-info" }] }),
    commentsReply(47, comments),
  ]);
  assert.deepEqual(askOps({ op: "claim", number: 47, ...LANE }), {
    ok: true,
    op: "claim",
    posted: 0,
    waiting: "answer",
  });
  assert.deepEqual(calls(), [
    getIssue(47),
    ghCalls.listComments(47),
    ghCalls.collaborator(ALLOWED),
  ]);
  assert.ok(!fs.existsSync(worktree(47)));
});

test("a claim that resumes a lapsed lease keeps its stage and its worktree", () => {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-44 ${worktree(44)} origin/integration && touch ${worktree(44)}/wip`,
  );
  const state = stateComment(12, {
    stage: "implement",
    lease: { lane: "other", sweepId: "s0", at: LAPSED },
    pr: null,
  });
  const mine = claimComment(101, "me", "s0", LIVE);
  reply([
    issueReply(44, { labels: [{ name: "agent:working" }] }),
    commentsReply(44, [claimComment(13, "other", "s0", LAPSED), state]),
    { when: "issues/44/comments -f", stdout: JSON.stringify(mine) },
    commentsReply(44, [mine]),
    commentsReply(44, [state]),
  ]);
  const kept = { pr: null, stage: "implement", lease: LEASE };
  assert.deepEqual(
    askOps({ op: "claim", number: 44, ...LANE }),
    claimReply(44, {
      state: kept,
      claim: { id: 101, posted: true, waited: 0 },
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(44),
    ghCalls.listComments(44),
    postClaim(44),
    ghCalls.label(44, "agent:working"),
    ghCalls.listComments(44),
    ghCalls.unlabel(44, "agent:needs-info"),
    ghCalls.label(44, "agent:working"),
    ghCalls.listComments(44),
    patchState(44, 12, kept),
  ]);
  assert.ok(fs.existsSync(path.join(worktree(44), "wip")));
});

// A stopped #45 whose worktree has uncommitted edits, and whose branch on
// GitHub has a commit the worktree lacks.
function stoppedWithStaleWorktree() {
  sh(
    `git -C ${root}/clones/o__r worktree add -q -B agent/issue-45 ${worktree(45)} origin/integration && echo edit > ${worktree(45)}/f && touch ${worktree(45)}/wip`,
  );
  sh(
    `cd ${root}/seed && git checkout -qb agent/issue-45 integration && echo 3 > h && git add h && git commit -qm work && git push -q origin agent/issue-45`,
  );
  return sh(`git -C ${root}/seed rev-parse HEAD`);
}

test("a claim restarts a stopped issue and resets its worktree to the branch", () => {
  const sha = stoppedWithStaleWorktree();
  const stoppedAt = `${TIME} stopped: budget`;
  const comments = [
    claimComment(14, "me", "s0", LIVE),
    stateComment(15, {
      stage: "stopped",
      lease: null,
      pr: null,
      log: [stoppedAt],
    }),
  ];
  reply([
    issueReply(45, { labels: [{ name: "agent:stopped-budget" }] }),
    commentsReply(45, comments),
    { when: "pr list", stdout: "[]" },
    commentsReply(45, comments),
  ]);
  const state = { ...NEW_STATE, number: 45, headSha: sha, log: [stoppedAt] };
  assert.deepEqual(
    askOps({ op: "claim", number: 45, ...LANE }),
    claimReply(45, {
      state,
      claim: { id: 14, posted: false },
      remoteHead: sha,
    }),
  );
  assert.deepEqual(calls(), [
    getIssue(45),
    ghCalls.listComments(45),
    listOpenPrs(45),
    ghCalls.unlabel(45, "agent:needs-info"),
    ghCalls.unlabel(45, "agent:stopped-budget"),
    ghCalls.label(45, "agent:working"),
    ghCalls.listComments(45),
    patchState(45, 15, state),
  ]);
  assert.equal(sh(`git -C ${worktree(45)} rev-parse HEAD`), sha);
  assert.equal(sh(`git -C ${worktree(45)} status --porcelain`), "");
});
