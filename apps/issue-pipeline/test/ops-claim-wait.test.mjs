// @ts-check
// A claim of an issue the author asked about. The claim op no longer waits
// for an answer: the orchestrator holds a needs-info issue while its trusted
// inputs still hash to the revision asked on, so no job claims it (#243,
// orchestrator.test.mjs "needs-info holds while the input is the one asked
// on…", orchestrator-tick.test.mjs), and no pipeline comment, usage records
// included, changes that revision (#457, trusted-inputs.test.mjs "no
// pipeline comment changes the revision…"). Once a job claims it, the claim
// clears needs-info and keeps `asked` for the author, who clears it with its
// Gherkin.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { effectNames, stateOf } from "./gh-effects.mjs";
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
  stateComment,
  worktree,
} from "./ops-cli-test-kit.mjs";
// ops-v2-test-kit.mjs makes the clone a claim reads.
import "./ops-v2-test-kit.mjs";

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
    issueReply(ASKED_ISSUE, { labels }),
    commentsReply(ASKED_ISSUE, read),
    { when: `issues/${ASKED_ISSUE}/comments -f`, stdout: JSON.stringify(mine) },
    commentsReply(ASKED_ISSUE, [...read, mine]),
    commentsReply(ASKED_ISSUE, [...read, mine]),
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
