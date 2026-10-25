// The stage jobs the rate-limit deferral tests (`rate-limit-defers`) run
// through job-test-kit.ts: the errors a provider's rate limit, overload and
// transport failures give a session, and one job of issue #7 whose session
// pi fails with one of them, with what the job did.
import type { JobLine } from "../../src/job/role-end.ts";
import type { JobOutcome } from "../../src/job/status.ts";
import {
  AUTHOR_SESSION,
  implementReplies,
  READER_STAGE,
  repliesAt,
} from "../job-fixtures.ts";
import type { OpsLine, Place } from "./job-test-kit.ts";
import { logOf, runJob, setUp, statusOf } from "./job-test-kit.ts";

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

interface FailedSessionJob {
  place: Place;
  // the job's one line
  line: JobLine;
  // the ops the job asked for, in order
  ops: string[];
  // job.json's outcome
  outcome: JobOutcome | null | undefined;
}

// Returns the ops the job asked for
function jobOpsOf(place: Place): string[] {
  return logOf<OpsLine>(place, "ops.log").map(({ op }) => op);
}

// The ops a run's `trace` of requests asked for, in order. Kept for
// ops-claim-adopt-review.test.mjs.
function opsOf(trace: readonly { request?: { op: string } }[]): string[] {
  return trace.flatMap(({ request }) => {
    if (request === undefined) {
      return [];
    }
    return [request.op];
  });
}

// The stage and outcome of a run summary's one item. Kept for
// ops-claim-adopt-review.test.mjs.
function itemOf(summary: {
  items: readonly { stage: string | null; outcome: string }[];
}): { stage: string | null; outcome: string } {
  const { items } = summary;
  const [item] = items;
  if (item === undefined) {
    throw new Error("the summary has no item");
  }
  return { stage: item.stage, outcome: item.outcome };
}

function requestsOf(place: Place, op: string): OpsLine[] {
  return logOf<OpsLine>(place, "ops.log").filter(
    (request) => request.op === op,
  );
}

// A `stage` job of issue #7 (the author, or the implementor up to its
// session) whose session's prompt pi rejects with `failure`'s error.
function failedSessionJob(
  stage: "author" | "implement",
  failure: { error: string },
): FailedSessionJob {
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
function failedPostJob(error: string): FailedSessionJob {
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
