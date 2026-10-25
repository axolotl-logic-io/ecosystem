// @ts-check
// Every credentialed write of a bound ops request rereads ownership first
// (#169). Each row is an op's own success setup, but a successor takes the
// issue just after the request's ownership check (fake-ownership.mjs): the
// op's first write finds the issue no longer its own and nothing reaches
// GitHub. The refusal names the lost ownership, which only that fresh read
// before a write sees, so a row can't pass by failing earlier.
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { loseOwnership } from "../fake-ownership.mjs";
import {
  commentWriteReplies,
  labelReplies,
  stopMutationReplies,
} from "../gh-mutation-fixtures.mjs";
import { historyReply } from "../initial-write-state-fixtures.mjs";
import {
  kit,
  myClaim,
  reviewStopReplies,
  v2State,
} from "../ops-v2-test-kit.mjs";
import { sessionRecord } from "../usage-fixtures.mjs";

const { serializeUsage } = await import("../../src/job/usage-log.ts");

kit.requireGhReplies();
const {
  askOps,
  commentsReply,
  reply,
  root,
  sh,
  stateComment,
  worktree,
  writes,
} = kit;

const REFUSED = z.object({ ok: z.literal(false), error: z.string() });
// What the fresh ownership read before a write says once a successor took
// the issue (coordination-records.ts).
const LOST = /execution ownership lost or unconfirmed/u;
const LANE = { lane: "me", sweepId: "s1" };
const INPUTS_LENGTH = 64;
const SUBS_CLOSED = JSON.stringify([
  { number: 3, state: "closed", reason: "completed", labels: [] },
]);

/**
 * Each row: the op it runs, the replies its success needs, and its request.
 * @type {Record<string, { replies: () => void, request: object }>}
 */
const ROWS = {
  "queued and posted comments (post)": {
    replies: () => reply([{ when: "issues/60/comments -f", stdout: "901\n" }]),
    request: {
      op: "post",
      number: 60,
      comments: [{ number: 60, by: { role: "x" }, body: "b" }],
    },
  },
  "state (save-state)": {
    replies: () =>
      reply([
        { ...commentsReply(61, [stateComment(12, v2State(61))]), keep: true },
        ...commentWriteReplies("o/r", 61, [12]),
      ]),
    request: {
      op: "save-state",
      number: 61,
      state: v2State(61, { stage: "review" }),
    },
  },
  "comment, state, claim and labels (ask)": {
    replies: () =>
      reply([
        {
          ...commentsReply(62, [
            stateComment(5, v2State(62, { stage: "author" })),
            myClaim(6),
          ]),
          keep: true,
        },
        ...commentWriteReplies("o/r", 62, [5, 6]),
        ...labelReplies("o/r", 62, ["agent:needs-info"], ["agent:working"]),
      ]),
    request: {
      op: "ask",
      number: 62,
      questions: ["Which X?"],
      state: v2State(62, {
        stage: "author",
        asked: { inputs: "a".repeat(INPUTS_LENGTH) },
      }),
      by: { role: "author", agent: null, model: null, run: null },
    },
  },
  "keyed usage comment (usage)": {
    replies: () =>
      reply([
        { ...commentsReply(63, []), keep: true },
        ...commentWriteReplies("o/r", 63, []),
      ]),
    request: {
      op: "usage",
      number: 63,
      line: serializeUsage(sessionRecord({ attempt: 1 })),
    },
  },
  "stop comments, state and labels (stop)": {
    replies: () => reviewStopReplies(64, 74, 8),
    request: {
      op: "stop",
      number: 64,
      code: "review-rounds",
      reason: "too many rounds",
      state: v2State(64, { stage: "review", pr: 74 }),
    },
  },
  "completion close, labels and comment (close-parent)": {
    replies: () =>
      reply([
        { when: "sub_issues", stdout: SUBS_CLOSED },
        { when: "issue close 65 -R o/r", stdout: "" },
        ...labelReplies("o/r", 65, ["agent:merged"], ["agent:split"]),
        ...commentWriteReplies("o/r", 65, []),
      ]),
    request: { op: "close-parent", number: 65 },
  },
  "lease release and claim heartbeat (release)": {
    replies: () =>
      reply([
        {
          ...commentsReply(66, [stateComment(14, v2State(66)), myClaim(15)]),
          keep: true,
        },
        ...commentWriteReplies("o/r", 66, [14, 15]),
      ]),
    request: { op: "release", number: 66, ...LANE, state: v2State(66) },
  },
};

for (const [row, { replies, request }] of Object.entries(ROWS)) {
  test(`${row}: a successor taking the issue before the first write leaves GitHub unchanged`, () => {
    replies();
    loseOwnership();
    const refused = REFUSED.parse(askOps(request));
    assert.match(refused.error, LOST);
    assert.deepEqual(writes(), []);
  });
}

// Issue `n`'s branch on origin, and a worktree one commit past it, as a
// stopped implementer leaves it; returns the branch's head.
/** @param {number} n @returns {string} */
function worktreeAheadOfBranch(n) {
  sh(
    `cd ${root}/seed && git checkout -qB agent/issue-${n} integration && echo ${n} > b-${n} && git add b-${n} && git commit -qm branch && git push -q origin HEAD:refs/heads/agent/issue-${n}`,
  );
  const clone = `${root}/clones/o__r`;
  sh(`git -C ${clone} fetch -q origin`);
  sh(
    `git -C ${clone} worktree add -q -B agent/issue-${n} ${worktree(n)} origin/agent/issue-${n}`,
  );
  sh(
    `cd ${worktree(n)} && echo mine > mine && git add mine && git -c user.email=a@b -c user.name=a commit -qm mine`,
  );
  return sh(`git -C ${root}/origin.git rev-parse refs/heads/agent/issue-${n}`);
}

test("stop salvage push: a successor taking the issue before it leaves the branch and GitHub unchanged", () => {
  const n = 67;
  if (!sh(`ls ${root}`).split("\n").includes("clones")) {
    sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);
  }
  const branch = worktreeAheadOfBranch(n);
  const saved = v2State(n, { stage: "implement" });
  reply([
    {
      ...commentsReply(n, [stateComment(n, saved)]),
      keep: true,
      persistState: true,
    },
    historyReply(n),
    ...stopMutationReplies(n, { stateId: n, pr: null, code: "not-doable" }),
  ]);
  loseOwnership();
  const refused = REFUSED.parse(
    askOps({
      op: "stop",
      number: n,
      code: "not-doable",
      reason: "can't",
      state: saved,
    }),
  );
  assert.match(refused.error, LOST);
  assert.equal(
    sh(`git -C ${root}/origin.git rev-parse refs/heads/agent/issue-${n}`),
    branch,
  );
  assert.deepEqual(writes(), []);
});
