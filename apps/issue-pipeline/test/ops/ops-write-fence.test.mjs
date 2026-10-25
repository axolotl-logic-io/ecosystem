// @ts-check
// Every credentialed write of a bound ops request rereads ownership first
// (#169). Each row is an op's own success setup, but a successor takes the
// issue just after the request's ownership check (fake-ownership.mjs): the
// op's first write finds the issue no longer its own and nothing reaches
// GitHub. The refusal names the lost ownership, which only that fresh read
// before a write sees, so a row can't pass by failing earlier.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { acquisitionRefusal, loseOwnership } from "../fake-ownership.mjs";
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
  runDir,
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
// Each row's issue and the ids of the comments and PR its setup names.
const POST = { n: 60, posted: 901 };
const SAVE = { n: 61, state: 12 };
const ASK = { n: 62, state: 5, claim: 6 };
const USAGE = { n: 63 };
const STOP = { n: 64, pr: 74, claim: 8 };
const CLOSE = { n: 65 };
const RELEASE = { n: 66, state: 14, claim: 15 };
const SALVAGE = { n: 67 };
const LOST_REPLY = { n: 68 };
const UNBOUND_POST = { n: 69 };
// A write whose reply was lost, the journal that then holds the issue, and
// an unbound request's refusal.
const UNCERTAIN = /uncertain controlled mutation; preserve/u;
const RETAINED = /uncertain coordination write retained/u;
const UNBOUND = /an ops request without an execution binding cannot write/u;
const JOURNAL = z.object({
  operation: z.literal("controlled mutation"),
  instance: z.string(),
  evidence: z.object({ command: z.string(), args: z.array(z.string()) }),
});
const SUBS_CLOSED = JSON.stringify([
  { number: 3, state: "closed", reason: "completed", labels: [] },
]);

/**
 * Each row: the op it runs, the replies its success needs, and its request.
 * @type {Record<string, { replies: () => void, request: object }>}
 */
const ROWS = {
  "queued and posted comments (post)": {
    replies: () =>
      reply([
        { when: `issues/${POST.n}/comments -f`, stdout: `${POST.posted}\n` },
      ]),
    request: {
      op: "post",
      number: POST.n,
      comments: [{ number: POST.n, by: { role: "x" }, body: "b" }],
    },
  },
  "state (save-state)": {
    replies: () =>
      reply([
        {
          ...commentsReply(SAVE.n, [stateComment(SAVE.state, v2State(SAVE.n))]),
          keep: true,
        },
        ...commentWriteReplies("o/r", SAVE.n, [SAVE.state]),
      ]),
    request: {
      op: "save-state",
      number: SAVE.n,
      state: v2State(SAVE.n, { stage: "review" }),
    },
  },
  "comment, state, claim and labels (ask)": {
    replies: () =>
      reply([
        {
          ...commentsReply(ASK.n, [
            stateComment(ASK.state, v2State(ASK.n, { stage: "author" })),
            myClaim(ASK.claim),
          ]),
          keep: true,
        },
        ...commentWriteReplies("o/r", ASK.n, [ASK.state, ASK.claim]),
        ...labelReplies("o/r", ASK.n, ["agent:needs-info"], ["agent:working"]),
      ]),
    request: {
      op: "ask",
      number: ASK.n,
      questions: ["Which X?"],
      state: v2State(ASK.n, {
        stage: "author",
        asked: { inputs: "a".repeat(INPUTS_LENGTH) },
      }),
      by: { role: "author", agent: null, model: null, run: null },
    },
  },
  "keyed usage comment (usage)": {
    replies: () =>
      reply([
        { ...commentsReply(USAGE.n, []), keep: true },
        ...commentWriteReplies("o/r", USAGE.n, []),
      ]),
    request: {
      op: "usage",
      number: USAGE.n,
      line: serializeUsage(sessionRecord({ attempt: 1 })),
    },
  },
  "stop comments, state and labels (stop)": {
    replies: () => reviewStopReplies(STOP.n, STOP.pr, STOP.claim),
    request: {
      op: "stop",
      number: STOP.n,
      code: "review-rounds",
      reason: "too many rounds",
      state: v2State(STOP.n, { stage: "review", pr: STOP.pr }),
    },
  },
  "completion close, labels and comment (close-parent)": {
    replies: () =>
      reply([
        { when: "sub_issues", stdout: SUBS_CLOSED },
        { when: `issue close ${CLOSE.n} -R o/r`, stdout: "" },
        ...labelReplies("o/r", CLOSE.n, ["agent:merged"], ["agent:split"]),
        ...commentWriteReplies("o/r", CLOSE.n, []),
      ]),
    request: { op: "close-parent", number: CLOSE.n },
  },
  "lease release and claim heartbeat (release)": {
    replies: () =>
      reply([
        {
          ...commentsReply(RELEASE.n, [
            stateComment(RELEASE.state, v2State(RELEASE.n)),
            myClaim(RELEASE.claim),
          ]),
          keep: true,
        },
        ...commentWriteReplies("o/r", RELEASE.n, [
          RELEASE.state,
          RELEASE.claim,
        ]),
      ]),
    request: {
      op: "release",
      number: RELEASE.n,
      ...LANE,
      state: v2State(RELEASE.n),
    },
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
  const { n } = SALVAGE;
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

// A write whose reply is lost keeps its exact intent in the issue's journal
// and holds: a replay of the request writes nothing, and a new job's
// acquisition after a restart is refused until a person reconciles.
test("a lost write reply keeps its intent, and neither a replay nor a new job repeats it", () => {
  const { n } = LOST_REPLY;
  const request = {
    op: "post",
    number: n,
    comments: [{ number: n, by: { role: "x" }, body: "once" }],
  };
  reply([
    {
      when: `issues/${n}/comments -f`,
      stderr: "HTTP 502: Bad Gateway",
      code: 1,
    },
  ]);
  const lost = REFUSED.parse(askOps(request));
  assert.match(lost.error, UNCERTAIN);
  const journal = path.join(runDir(n), "coordination-uncertain.json");
  const intent = JOURNAL.parse(JSON.parse(fs.readFileSync(journal, "utf8")));
  assert.equal(intent.evidence.command, "gh");
  assert.ok(intent.evidence.args.some((arg) => arg.includes("once")));
  const posts = writes().length;
  assert.equal(posts, 1);
  // The same request again: the journal refuses it before any write.
  assert.match(REFUSED.parse(askOps(request)).error, RETAINED);
  assert.equal(writes().length, posts);
  // A restart: the next job can't acquire, and its request can't write.
  reply([{ when: `issues/${n}/comments -f`, stdout: "902\n" }]);
  assert.match(REFUSED.parse(askOps(request)).error, UNBOUND);
  assert.match(acquisitionRefusal(), RETAINED);
  assert.deepEqual(writes(), []);
  assert.ok(fs.existsSync(journal));
});

test("an ops request with no binding can't write", () => {
  const { n } = UNBOUND_POST;
  reply([{ when: `issues/${n}/comments -f`, stdout: "903\n" }]);
  const request = {
    op: "post",
    number: n,
    comments: [{ number: n, by: { role: "x" }, body: "b" }],
  };
  assert.match(REFUSED.parse(askOps(request, true)).error, UNBOUND);
  assert.deepEqual(writes(), []);
});
