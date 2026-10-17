// Stopping a stage job with SIGTERM or SIGINT: it aborts its pi sessions,
// saves the issue at its stage with no lease, and exits 128 + the signal.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { alive, waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  logOf,
  PASS_VERDICT,
  piCommands,
  piStarts,
  repliesAt,
  SWEEP_STAGE,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

const STAGE_ARGS = ["--stage", SWEEP_STAGE, "--lane", "L"];
// 128 + each signal's number.
const STOPPED_BY_SIGTERM = 143;
const STOPPED_BY_SIGINT = 130;
/** @type {[NodeJS.Signals, number][]} */
const SIGNAL_CODES = [
  ["SIGTERM", STOPPED_BY_SIGTERM],
  ["SIGINT", STOPPED_BY_SIGINT],
];

// A stop saves the issue at its stage with no lease, through save-state only.
const SAVED_AT_STAGE = {
  released: false,
  saved: { stage: SWEEP_STAGE, lease: null },
};

// Whether the stopped job released the issue, which would renew its lease,
// and the state it last saved through save-state.
/** @param {import("./job-test-kit.mjs").Place} place @returns {{ released: boolean, saved: { stage: unknown, lease: unknown } }} */
function stopSaveOf(place) {
  const ops = logOf(place, "ops.log");
  const [save] = ops.filter(({ op }) => op === "save-state").slice(-1);
  return {
    released: ops.some(({ op }) => op === "release"),
    saved: { stage: save?.state.stage, lease: save?.state.lease },
  };
}

for (const [signal, code] of SIGNAL_CODES) {
  test(`${signal} aborts the session, saves the issue at its stage with no lease and exits ${code}`, async () => {
    const place = setUp(repliesAt(SWEEP_STAGE), {
      events: [messageEnd(USAGE), "wait", outputEnd(PASS_VERDICT)],
    });
    const job = startJob(place, STAGE_ARGS);
    await waitFor(
      "the session's usage in job.json",
      () => sessionOf(statusOf(place))?.usage.input > 0,
    );
    job.child.kill(signal);
    const end = await job.end;
    assert.equal(end.status, code, end.stderr);
    assert.equal(end.stdout, "");
    assert.match(end.stderr, new RegExp(`job: stopped by ${signal}`, "u"));
    assert.ok(piCommands(place).some(({ type }) => type === "abort"));
    assert.deepEqual(stopSaveOf(place), SAVED_AT_STAGE);
    const status = statusOf(place);
    assert.deepEqual(status.outcome, { kind: "stopped", signal });
    assert.equal(sessionOf(status).outcome, null);
    assert.equal(fs.existsSync(status.socket), false);
  });
}

test("a session that ignores the abort is killed after the grace period, and the job still saves", async () => {
  const place = setUp(repliesAt(SWEEP_STAGE), {
    events: ["wait"],
    ignoreAbort: true,
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor("pi got the prompt", () =>
    piCommands(place).some(({ type }) => type === "prompt"),
  );
  const [{ pid }] = piStarts(place);
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(alive(pid), false);
  assert.deepEqual(stopSaveOf(place), SAVED_AT_STAGE);
});
