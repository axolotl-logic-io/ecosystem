// @ts-check
// A stop while a role's end asks its questions (#457): SIGTERM or SIGINT
// that arrives while the `ask` op runs leaves the asked state the ask
// writes, with the inputs revision the questions were asked at. Before #457
// the job's stop saved the state the role last saved, from before the ask,
// with no lease, and so wrote over the questions' record. The author is the
// one role whose end asks. The fake ops logs each request; the issue's state
// is worked out from them, with the hung ask's write taken as done, as the
// real op does it before it answers.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "../bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "../fake-rpc-pi.mjs";
import { ASKING, READER_STAGE, repliesAt, USAGE } from "../job-fixtures.mjs";
import { logOf, setUp, startJob } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// Where the fake ops writes the pid of the hung op's sleep.
const OP_FAILED = /op failed/u;
const HANG_PID = "hang.pid";
// 128 + each signal's number.
const STOPPED_BY_SIGTERM = 143;
const STOPPED_BY_SIGINT = 130;
/** @type {[NodeJS.Signals, number][]} */
const SIGNAL_CODES = [
  ["SIGTERM", STOPPED_BY_SIGTERM],
  ["SIGINT", STOPPED_BY_SIGINT],
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
 * and release writes its state, and each ask its payload's state with no
 * lease (src/ops/ask.ts).
 * @param {Place} place
 * @returns {{ state: any, asked: any }}
 */
function issueStateOf(place) {
  /** @type {any} */
  let state = {};
  /** @type {any} */
  let asked = {};
  for (const request of logOf(place, "ops.log")) {
    if (request.op === "save-state" || request.op === "release") {
      state = recordOf(request.state);
    } else if (request.op === "ask") {
      asked = recordOf(request.state);
      state = { ...asked, lease: null };
    }
  }
  return { state, asked };
}

for (const [signal, code] of SIGNAL_CODES) {
  test(`a ${signal} while the author's end asks leaves the asked state the ask wrote`, async () => {
    const replies = { ...repliesAt(READER_STAGE), ask: { hang: true } };
    const place = setUp(replies, {
      events: [messageEnd(USAGE), outputEnd(ASKING)],
    });
    endsWithTest(() => {
      const sleep = pidIn(place.root, HANG_PID);
      if (sleep !== null && alive(sleep)) {
        killGroup(sleep);
      }
    });
    const job = startJob(place, ["--stage", READER_STAGE]);
    await waitFor(
      "the hung ask's sleep",
      () => pidIn(place.root, HANG_PID) !== null,
    );
    job.child.kill(signal);
    const end = await job.end;
    assert.equal(end.status, code, end.stderr);
    assert.doesNotMatch(end.stderr, OP_FAILED);
    const { state, asked } = issueStateOf(place);
    assert.equal(typeof asked.asked?.inputs, "string");
    assert.deepEqual(
      { stage: state.stage, lease: state.lease, asked: state.asked },
      { stage: READER_STAGE, lease: null, asked: asked.asked },
    );
  });
}
