// @ts-check
// The claim op's wait on a needs-info issue that no allowed user has answered
// since its questions: it changes nothing and makes no worktree (#243). An
// issue saved as an asking spec run saves it waits on its usage-records
// comment from before the questions, and an allowed user's later comment
// answers it (#457, after #419 was claimed two minutes after it asked).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { effectNames } from "./gh-effects.mjs";
import { issueReply, LANE, LAPSED, LIVE } from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  claimComment,
  commentsReply,
  effects,
  issueComment,
  reply,
  root,
  sh,
  stateComment,
  worktree,
  writes,
} from "./ops-cli-test-kit.mjs";

const BEFORE_LAPSED = "2019-01-01T00:00:00Z";
// The issue, and the ids of its state comment and of the answer that came too
// early to count.
const WAITING_ISSUE = 47;
const WAITING_STATE = 17;
const EARLY_ANSWER = 18;
// #419's times: the usage-records comment, the spec writer's questions and
// an allowed user's answer after them.
const USAGE_AT = "2026-10-17T23:59:50Z";
const ASKED_AT = "2026-10-18T04:26:32.000Z";
const ANSWERED_AT = "2026-10-18T05:00:00Z";
// The asked issue, and the ids of its state, usage and answer comments.
const ASKED_ISSUE = 48;
const ASKED_STATE = 19;
const USAGE_COMMENT = 20;
const ANSWER = 21;
const CLAIM = 22;
// The state a spec run that asks saves (#457): at triage, with no lease, the
// questions' time, the spec so far and its counts at 0.
const ASKED = {
  version: 1,
  number: ASKED_ISSUE,
  depth: 0,
  stage: "triage",
  lease: null,
  pr: null,
  questionsAt: ASKED_AT,
  spec: "## Behaviour\n\n- It works.",
  checkpoints: {
    startSha: null,
    startWikiSha: null,
    attempts: 0,
    continuations: 0,
  },
};
// The account's usage-records comment: an allowed user's, with no role mark.
const USAGE_BODY = `Issue pipeline usage records (hidden; see the wiki)\n<!-- issue-pipeline:${ASKED_ISSUE}:usage -->`;

// A claim runs after a sweep, which made the clone.
sh(`git clone -q ${root}/origin.git ${root}/clones/o__r`);

test("a claim of a needs-info issue with no answer waits and changes nothing", () => {
  const comments = [
    stateComment(WAITING_STATE, {
      stage: "triage",
      questionsAt: LAPSED,
      pr: null,
    }),
    issueComment(EARLY_ANSWER, "too early", ALLOWED, BEFORE_LAPSED),
  ];
  reply([
    issueReply(WAITING_ISSUE, { labels: [{ name: "agent:needs-info" }] }),
    commentsReply(WAITING_ISSUE, comments),
  ]);
  assert.deepEqual(askOps({ op: "claim", number: WAITING_ISSUE, ...LANE }), {
    ok: true,
    op: "claim",
    posted: 0,
    commentIds: [],
    waiting: "answer",
  });
  assert.deepEqual(writes(), []);
  assert.ok(!fs.existsSync(worktree(WAITING_ISSUE)));
});

/** @param {readonly object[]} comments @returns {unknown} the reply to a claim of the asked issue with `comments` */
function claimAsked(comments) {
  const all = [stateComment(ASKED_STATE, ASKED), ...comments];
  const mine = claimComment(CLAIM, "me", "s1", LIVE);
  reply([
    issueReply(ASKED_ISSUE, { labels: [{ name: "agent:needs-info" }] }),
    commentsReply(ASKED_ISSUE, all),
    { when: `issues/${ASKED_ISSUE}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(ASKED_ISSUE, [...all, mine]),
  ]);
  return askOps({ op: "claim", number: ASKED_ISSUE, ...LANE });
}

test("a claim of an asked issue whose only comment since is from before its questions waits", () => {
  const usage = issueComment(USAGE_COMMENT, USAGE_BODY, ALLOWED, USAGE_AT);
  assert.deepEqual(claimAsked([usage]), {
    ok: true,
    op: "claim",
    posted: 0,
    commentIds: [],
    waiting: "answer",
  });
  assert.deepEqual(writes(), []);
  assert.ok(!fs.existsSync(worktree(ASKED_ISSUE)));
});

test("an allowed user's comment after the questions answers an asked issue, and the claim takes it", () => {
  const usage = issueComment(USAGE_COMMENT, USAGE_BODY, ALLOWED, USAGE_AT);
  const answer = issueComment(ANSWER, "Page 2.", ALLOWED, ANSWERED_AT);
  const got = claimAsked([usage, answer]);
  assert.partialDeepStrictEqual(got, { ok: true, op: "claim" });
  const claimed = new Object(got);
  assert.equal(Reflect.has(claimed, "waiting"), false);
  assert.equal(Reflect.has(claimed, "lost"), false);
  const names = effectNames(effects());
  assert.ok(names.includes(`unlabel #${ASKED_ISSUE} agent:needs-info`));
});
