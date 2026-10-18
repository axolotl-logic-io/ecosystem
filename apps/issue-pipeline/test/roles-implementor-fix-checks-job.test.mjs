// @ts-check
// One implementor job runs fix then checks (#424, `implementor-one-job`):
// mock model (the fake RPC pi), local git origins and fake ops. A fix whose
// findings all resolve saves the issue at checks and carries on at the
// checks entry in the same job, whose job.json then names checks; a job
// killed once fix saved resumes at checks, as the watchdog restarts it from
// the stage its job.json names now, with no fixer session again.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  endOf,
  fixReplies,
  requestsOf,
  savedAt,
  VERIFIED,
} from "./implementor-fix-job-test-kit.mjs";
import { FIX_DONE, RESOLVED } from "./implementor-fix-test-kit.mjs";
import { PUSHED } from "./implementor-job-test-kit.mjs";
import {
  logOf,
  piStarts,
  runJob,
  setUp,
  startJob,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const RUN = ["--stage", "fix"];
// The fixer and the re-reviewer.
const FIX_SESSIONS = 2;
const STOPPED_BY_SIGTERM = 143;
// Where the fake ops writes the pid of the hung op's sleep.
const HANG_PID = "hang.pid";
const PASSED = { kind: "saved", stage: "accept" };

/** @param {unknown} reply @returns {object[]} a session that spends USAGE and replies `reply` */
function session(reply) {
  return [messageEnd(USAGE), outputEnd(reply)];
}

/** @returns {{ launches: object[][] }} the fixer's and re-reviewer's sessions, which resolve F1 */
function fixSessions() {
  return { launches: [session(FIX_DONE), session(RESOLVED)] };
}

/** @param {Place} place @returns {string[]} the ops the job sent, each save-state with the stage it saved */
function opsSent(place) {
  return logOf(place, "ops.log").map((request) => {
    if (request.op === "save-state") {
      return `save-state:${request.state.stage}`;
    }
    return String(request.op);
  });
}

/** @param {Place} place @param {Record<string, unknown>} changes sets `changes` in the fake ops' replies */
function replyWith(place, changes) {
  const file = path.join(place.root, "replies.json");
  const replies = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...replies, ...changes }));
}

test("a fix whose findings all resolve runs checks in the same job, and job.json names checks once it gets there", () => {
  const place = setUp(fixReplies(), fixSessions());
  const r = runJob(place, RUN);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), PASSED);
  assert.equal(piStarts(place).length, FIX_SESSIONS);
  const ops = opsSent(place);
  assert.ok(
    ops.indexOf("save-state:checks") < ops.indexOf("verify"),
    ops.join(),
  );
  assert.equal(requestsOf(place, "verify").length, 1);
  assert.equal(requestsOf(place, "ci-status")[0]?.expectedSha, PUSHED);
  assert.equal(savedAt(place, "accept")?.verifiedSha, PUSHED);
  const status = statusOf(place);
  assert.equal(status.stage, "fix");
  assert.equal(status.currentStage, "checks");
});

test("a job killed after fix saved resumes at checks, with no fixer session again", async () => {
  const hung = { ...fixReplies(), verify: { hang: true } };
  const place = setUp(hung, fixSessions());
  endsWithTest(() => {
    const sleep = pidIn(place.root, HANG_PID);
    if (sleep !== null && alive(sleep)) {
      killGroup(sleep);
    }
  });
  const job = startJob(place, RUN);
  await waitFor(
    "the hung verify's sleep",
    () => pidIn(place.root, HANG_PID) !== null,
  );
  assert.equal(statusOf(place).currentStage, "checks");
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  const stopped = requestsOf(place, "save-state").at(-1)?.state;
  assert.deepEqual(
    { stage: stopped?.stage, lease: stopped?.lease },
    { stage: "checks", lease: null },
  );
  const replies = JSON.parse(
    fs.readFileSync(path.join(place.root, "replies.json"), "utf8"),
  );
  replyWith(place, {
    verify: VERIFIED,
    claim: { ...replies.claim, state: stopped },
  });
  const r = runJob(place, ["--stage", statusOf(place).currentStage]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(endOf(r), PASSED);
  assert.equal(piStarts(place).length, FIX_SESSIONS);
  assert.equal(requestsOf(place, "push").length, 1);
  assert.equal(requestsOf(place, "prepare-review").length, 1);
  assert.equal(requestsOf(place, "verify").length, 2);
  assert.equal(statusOf(place).stage, "checks");
});
