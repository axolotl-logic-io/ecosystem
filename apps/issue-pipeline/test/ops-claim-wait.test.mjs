// @ts-check
// The claim op's wait on a needs-info issue that no allowed user has answered
// since its questions: it changes nothing and makes no worktree (#243).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { issueReply, LANE, LAPSED } from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  commentsReply,
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
    waiting: "answer",
  });
  assert.deepEqual(writes(), []);
  assert.ok(!fs.existsSync(worktree(WAITING_ISSUE)));
});
