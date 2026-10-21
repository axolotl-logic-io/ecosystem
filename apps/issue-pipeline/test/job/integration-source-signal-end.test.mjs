// @ts-check
// A stop while a role's end is applied (src/job/role-run.ts, role-end.ts):
// SIGTERM or SIGINT that ends the ask or release op the end runs stops the
// job with 128 + the signal's number, never fails it, and saves the run's
// last state with no lease. An ask's last state is the asked state, with the
// inputs revision the questions were asked at, from before its op runs
// (#457); a release's is the claimed one, since the release never finished.
// Each job runs `node src/job.ts` with the job kit's fake ops and pi, in a
// temporary pipeline root and HOME.
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "../bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "../fake-rpc-pi.mjs";
import {
  ASKING,
  AUTHOR_SESSION,
  READER_STAGE,
  repliesAt,
  USAGE,
} from "../job-fixtures.mjs";
import { logOf, setUp, startJob } from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

// Where the fake ops writes the pid of a hung op's sleep.
const HANG_PID = "hang.pid";
const TEMPORARY_ROOT = "/tmp/issue-pipeline-job-";
// 128 + each signal's number.
const STOPPED_BY_SIGTERM = 143;
const STOPPED_BY_SIGINT = 130;
/** @type {[NodeJS.Signals, number][]} */
const SIGNAL_CODES = [
  ["SIGTERM", STOPPED_BY_SIGTERM],
  ["SIGINT", STOPPED_BY_SIGINT],
];
// A failed end op's error, which a stop never reports.
const OP_FAILED = /op failed/u;
// The ops that write the issue's state.
const STATE_WRITES = new Set(["release", "save-state", "ask", "stop"]);
const ASKING_SESSION = { events: [messageEnd(USAGE), outputEnd(ASKING)] };

/**
 * Starts a stage job whose `hung` op never answers, in a temporary root and
 * HOME, sends it `signal` once that op runs, and returns its end and the ops
 * it asked for.
 * @param {string} hung
 * @param {object} session
 * @param {NodeJS.Signals} signal
 */
async function stoppedDuring(hung, session, signal) {
  const replies = { ...repliesAt(READER_STAGE), [hung]: { hang: true } };
  /** @type {Place} */
  const place = setUp(replies, session);
  if (!place.root.startsWith(TEMPORARY_ROOT)) {
    throw new Error(`refusing a pipeline root outside ${TEMPORARY_ROOT}`);
  }
  endsWithTest(() => {
    const sleep = pidIn(place.root, HANG_PID);
    if (sleep !== null && alive(sleep)) {
      killGroup(sleep);
    }
  });
  const home = Object.fromEntries([["HOME", path.join(place.tmp, "home")]]);
  const job = startJob(place, ["--stage", READER_STAGE], home);
  await waitFor(`the hung ${hung}`, () => pidIn(place.root, HANG_PID) !== null);
  job.child.kill(signal);
  const end = await job.end;
  const writes = logOf(place, "ops.log").filter(({ op }) =>
    STATE_WRITES.has(op),
  );
  return { end, writes };
}

for (const [signal, code] of SIGNAL_CODES) {
  test(`a ${signal} during the ask op stops the job and saves the asked state with no lease`, async () => {
    const { end, writes } = await stoppedDuring("ask", ASKING_SESSION, signal);
    assert.equal(end.status, code, end.stderr);
    assert.doesNotMatch(end.stderr, OP_FAILED);
    assert.deepEqual(
      writes.map(({ op }) => op),
      ["ask", "save-state"],
    );
    const [ask, last] = writes;
    assert.equal(typeof ask?.state.asked?.inputs, "string");
    assert.deepEqual(
      {
        stage: last?.state.stage,
        lease: last?.state.lease,
        asked: last?.state.asked,
      },
      { stage: READER_STAGE, lease: null, asked: ask?.state.asked },
    );
  });
}

test("a SIGTERM during the release op stops the job and saves the claimed state with no lease", async () => {
  const { end, writes } = await stoppedDuring(
    "release",
    AUTHOR_SESSION,
    "SIGTERM",
  );
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.doesNotMatch(end.stderr, OP_FAILED);
  assert.deepEqual(
    writes.map(({ op }) => op),
    ["release", "save-state"],
  );
  const [, saved] = writes;
  assert.equal(saved?.state.stage, READER_STAGE);
  assert.equal(saved?.state.lease, null);
});
