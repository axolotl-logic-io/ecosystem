// @ts-check
// The stage jobs the rate-limit deferral tests (`rate-limit-defers`) run
// through job-test-kit.mjs: the errors a provider's rate limit, overload and
// transport failures give a session, and one job of issue #7 whose session
// pi fails with one of them, with what the job did.
import {
  AUTHOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
} from "./job-fixtures.mjs";
import { logOf, runJob, setUp, statusOf } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// The error pi gave the sessions of #303, #304 and #316 at 01:02Z.
const COOLING_DOWN = {
  ok: false,
  error:
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"All credentials for model claude-opus-5-5 are cooling down via provider claude"}}',
};
const OVERLOADED = {
  ok: false,
  error:
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
};
// The error pi gave #369's implementer at turn 39 (#385), with made-up
// addresses.
const CONNECTION_RESET = {
  ok: false,
  error:
    '{"type":"error","error":{"type":"api_error","message":"read tcp 10.0.0.5:51234->1.2.3.4:443: read: connection reset by peer"}}',
};
const SOCKET_RESET = { ok: false, error: "Error: read ECONNRESET" };
// A provider error that names no transport failure, which still stops.
const SERVER_ERROR = {
  ok: false,
  error:
    '{"type":"error","error":{"type":"api_error","message":"Internal server error at 10.0.0.5:51234"}}',
};
const TIMED_OUT = { ok: false, error: "the session timed out" };

/**
 * @typedef {object} FailedSessionJob
 * @property {Place} place
 * @property {any} line the job's one line
 * @property {string[]} ops the ops the job asked for, in order
 * @property {any} outcome job.json's outcome
 */

/** @param {Place} place @returns {string[]} the ops the job asked for */
function jobOpsOf(place) {
  return logOf(place, "ops.log").map(({ op }) => op);
}

// The ops a run's `trace` of requests asked for, in order. Kept for
// ops-claim-adopt-review.test.mjs.
/** @param {readonly { request?: unknown }[]} trace @returns {string[]} */
function opsOf(trace) {
  return trace.flatMap(({ request }) => {
    if (request === undefined) {
      return [];
    }
    return [/** @type {{ op: string }} */ (request).op];
  });
}

// The stage and outcome of a run summary's one item. Kept for
// ops-claim-adopt-review.test.mjs.
/** @param {unknown} summary @returns {{ stage: string | null, outcome: string }} */
function itemOf(summary) {
  const { items } =
    /** @type {{ items: { stage: string | null, outcome: string }[] }} */ (
      summary
    );
  const [item] = items;
  if (item === undefined) {
    throw new Error("the summary has no item");
  }
  return { stage: item.stage, outcome: item.outcome };
}

/** @param {Place} place @param {string} op @returns {any[]} */
function requestsOf(place, op) {
  return logOf(place, "ops.log").filter((request) => request.op === op);
}

// A `stage` job of issue #7 (the author, or the implementor up to its
// session) whose session's prompt pi rejects with `failure`'s error.
/**
 * @param {"author" | "implement"} stage
 * @param {{ error: string }} failure
 * @returns {FailedSessionJob}
 */
function failedSessionJob(stage, failure) {
  let replies = implementReplies();
  if (stage === READER_STAGE) {
    replies = repliesAt(READER_STAGE);
  }
  const place = setUp(replies, { rejectPrompt: failure.error });
  const r = runJob(place, ["--stage", stage, "--lane", "L"]);
  if (r.status !== 0) {
    throw new Error(`the job failed: ${r.stderr}`);
  }
  return {
    place,
    line: JSON.parse(r.stdout),
    ops: jobOpsOf(place),
    outcome: statusOf(place)?.outcome,
  };
}

// An author job whose post op fails with `error`, its session ending well.
/** @param {string} error @returns {FailedSessionJob} */
function failedPostJob(error) {
  const replies = { ...repliesAt(READER_STAGE), post: { ok: false, error } };
  const place = setUp(replies, AUTHOR_SESSION);
  const r = runJob(place, ["--stage", READER_STAGE, "--lane", "L"]);
  if (r.status !== 0) {
    throw new Error(`the job failed: ${r.stderr}`);
  }
  return {
    place,
    line: JSON.parse(r.stdout),
    ops: jobOpsOf(place),
    outcome: statusOf(place)?.outcome,
  };
}

export {
  CONNECTION_RESET,
  COOLING_DOWN,
  failedPostJob,
  failedSessionJob,
  itemOf,
  OVERLOADED,
  opsOf,
  requestsOf,
  SERVER_ERROR,
  SOCKET_RESET,
  TIMED_OUT,
};
