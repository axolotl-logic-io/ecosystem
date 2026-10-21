// @ts-check
// Claims refuse unanswered saved questions before claim or working-label
// writes. A changed trusted-input revision resumes the retained mode.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import { trustedInputBytes } from "../src/trusted-inputs.ts";
import { effectNames, stateOf } from "./gh-effects.mjs";
import {
  claimMutationReplies,
  collaboratorReply,
} from "./gh-mutation-fixtures.mjs";
import { historyReply } from "./initial-write-state-fixtures.mjs";
import {
  claimedState,
  claimReply,
  issueOf,
  issueReply,
  LANE,
  LIVE,
} from "./ops-claim-test-kit.mjs";
import {
  ALLOWED,
  askOps,
  claimComment,
  commentsReply,
  effects,
  issueComment,
  reply,
  requireGhReplies,
  stateComment,
  worktree,
} from "./ops-cli-test-kit.mjs";
// ops-v2-test-kit.mjs makes the clone a claim reads.
import "./ops-v2-test-kit.mjs";

requireGhReplies();

const { newIssueState } = await import("../src/state.ts");

// The asked issue, and the ids of its state, answer and claim comments.
const ASKED_ISSUE = 48;
const ASKED_STATE = 19;
const ANSWER = 21;
const CLAIM = 22;
const ANSWERED_AT = "2026-10-18T05:00:00Z";
// The trusted-inputs revision the author's questions were asked at.
const INPUTS_LENGTH = 64;
const ASKED_INPUTS = "a".repeat(INPUTS_LENGTH);

test("a claim of an answered, asked issue takes it, clearing needs-info and keeping asked for the author", () => {
  const saved = {
    ...newIssueState(ASKED_ISSUE),
    asked: { inputs: ASKED_INPUTS },
  };
  const answer = issueComment(ANSWER, "Page 2.", ALLOWED, ANSWERED_AT);
  const read = [stateComment(ASKED_STATE, saved), answer];
  const mine = claimComment(CLAIM, LANE.lane, LANE.sweepId, LIVE);
  const labels = [{ name: "agent:needs-info" }];
  reply([
    collaboratorReply("o/r", ALLOWED),
    historyReply(ASKED_ISSUE),
    issueReply(ASKED_ISSUE, { labels }),
    commentsReply(ASKED_ISSUE, read),
    { when: `issues/${ASKED_ISSUE}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(ASKED_ISSUE, [...read, mine]),
    commentsReply(ASKED_ISSUE, [...read, mine]),
    ...claimMutationReplies(ASKED_ISSUE, ASKED_STATE, null),
  ]);
  const state = claimedState(ASKED_ISSUE, { asked: { inputs: ASKED_INPUTS } });
  assert.deepEqual(
    askOps({ op: "claim", number: ASKED_ISSUE, ...LANE }),
    claimReply(ASKED_ISSUE, {
      state,
      claim: { id: CLAIM, posted: true },
      issue: issueOf(ASKED_ISSUE, { labels }),
      comments: read,
    }),
  );
  const claimed = effects();
  assert.deepEqual(effectNames(claimed), [
    `comment #${ASKED_ISSUE} role=claim`,
    `edit comment ${ASKED_STATE} state`,
    `label #${ASKED_ISSUE} agent:working`,
    `unlabel #${ASKED_ISSUE} agent:needs-info`,
  ]);
  assert.deepEqual(
    stateOf(claimed, `edit comment ${ASKED_STATE} state`),
    state,
  );
  assert.ok(fs.existsSync(worktree(ASKED_ISSUE)));
});

const UNANSWERED_ISSUE = 49;
for (const stage of /** @type {const} */ (["author", "implement"])) {
  test(`a claim at ${stage} refuses unanswered trusted requirements without mutation`, () => {
    const issue = {
      title: "Which behavior?",
      body: "Choose one",
      user: { login: ALLOWED },
    };
    const inputs = createHash("sha256")
      .update(trustedInputBytes(issue, []))
      .digest("hex");
    const state = {
      ...newIssueState(UNANSWERED_ISSUE, stage),
      asked: { inputs },
    };
    reply([
      collaboratorReply("o/r", ALLOWED),
      issueReply(UNANSWERED_ISSUE, issue),
      commentsReply(UNANSWERED_ISSUE, [stateComment(ASKED_STATE, state)]),
    ]);
    const result = askOps({ op: "claim", number: UNANSWERED_ISSUE, ...LANE });
    assert.deepEqual(result, {
      ok: true,
      op: "claim",
      posted: 0,
      commentIds: [],
      waiting: "answer",
    });
    assert.deepEqual(effects(), []);
    assert.equal(fs.existsSync(worktree(UNANSWERED_ISSUE)), false);
  });
}
