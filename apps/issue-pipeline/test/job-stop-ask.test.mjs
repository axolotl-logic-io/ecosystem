// @ts-check
// A stop while a role's end asks its questions (#457): SIGTERM or SIGINT
// that arrives while the `ask` op runs, after the end's save, leaves the
// questions' time the ask writes. Before #457 the job's stop saved the state
// the role last saved, from before the ask, with no lease, and so wrote over
// `questionsAt`, for triage and the spec writer alike. The fake ops logs
// each request; the issue's state is worked out from them, with the hung
// ask's write taken as done, as the real op does it before it answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import { logOf, repliesAt, setUp, startJob, USAGE } from "./job-test-kit.mjs";
import { replyOf as specReplyOf } from "./spec-writer-role-test-kit.mjs";
import { replyOf as triageReplyOf } from "./triage-role-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// Where the fake ops writes the pid of the hung op's sleep.
const HANG_PID = "hang.pid";
// The time the worked-out state gives the ask's write.
const ASKED = "asked";
const STOPPED_BY_SIGTERM = 143;
const QUESTIONS = ["Which page?"];
// Each role whose end asks: its stage and its session's reply.
const ASKING_ROLES = [
  {
    stage: "triage",
    reply: triageReplyOf({ decision: "needs-info", questions: QUESTIONS }),
  },
  {
    stage: "spec",
    reply: specReplyOf({
      decision: "needs-info",
      questions: QUESTIONS,
      interfaces: [],
    }),
  },
];

/** @param {unknown} value @returns {Record<string, unknown>} */
function recordOf(value) {
  if (typeof value === "object" && value !== null) {
    return { ...value };
  }
  return {};
}

/**
 * The issue's state after the job's ops requests, in order: each save-state
 * writes its state, and each ask its payload's state at triage, asked at
 * ASKED, with no lease (src/ops/ask.ts).
 * @param {Place} place
 * @returns {Record<string, unknown>}
 */
function issueStateOf(place) {
  /** @type {Record<string, unknown>} */
  let state = {};
  for (const request of logOf(place, "ops.log")) {
    if (request.op === "save-state") {
      state = recordOf(request.state);
    } else if (request.op === "ask") {
      const asked = recordOf(request.state);
      state = { ...asked, stage: "triage", questionsAt: ASKED, lease: null };
    }
  }
  return state;
}

for (const { stage, reply } of ASKING_ROLES) {
  test(`a SIGTERM while the ${stage} role's end asks leaves the questions' time the ask wrote`, async () => {
    const replies = { ...repliesAt(stage), ask: { hang: true } };
    const place = setUp(replies, {
      events: [messageEnd(USAGE), outputEnd(reply)],
    });
    endsWithTest(() => {
      const sleep = pidIn(place.root, HANG_PID);
      if (sleep !== null && alive(sleep)) {
        killGroup(sleep);
      }
    });
    const job = startJob(place, ["--stage", stage]);
    await waitFor(
      "the hung ask's sleep",
      () => pidIn(place.root, HANG_PID) !== null,
    );
    job.child.kill("SIGTERM");
    const end = await job.end;
    assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
    const { stage: savedAt, lease, questionsAt } = issueStateOf(place);
    assert.deepEqual(
      { stage: savedAt, lease, questionsAt },
      { stage: "triage", lease: null, questionsAt: ASKED },
    );
  });
}
