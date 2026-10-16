// Stopping a stage job with SIGTERM or SIGINT: it aborts its pi sessions,
// saves the issue at its stage with no lease, and exits 128 + the signal.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  alive,
  logOf,
  piCommands,
  piStarts,
  READY_SPEC,
  repliesAt,
  setUp,
  startJob,
  statusOf,
  USAGE,
  waitFor,
} from "./job-test-kit.mjs";

const STAGE_ARGS = ["--stage", "spec", "--lane", "L"];
// 128 + each signal's number.
const STOPPED_BY_SIGTERM = 143;
const STOPPED_BY_SIGINT = 130;
const SIGNAL_CODES = [
  ["SIGTERM", STOPPED_BY_SIGTERM],
  ["SIGINT", STOPPED_BY_SIGINT],
];

function sessionOf(status) {
  return status?.launches.find(({ kind }) => kind === "session") ?? null;
}

for (const [signal, code] of SIGNAL_CODES) {
  test(`${signal} aborts the session, saves the issue at its stage with no lease and exits ${code}`, async () => {
    const place = setUp(repliesAt("spec"), {
      events: [messageEnd(USAGE), "wait", outputEnd(READY_SPEC)],
    });
    const job = startJob(place, STAGE_ARGS);
    await waitFor(() => sessionOf(statusOf(place))?.usage.input > 0);
    job.child.kill(signal);
    const end = await job.end;
    assert.equal(end.status, code, end.stderr);
    assert.equal(end.stdout, "");
    assert.match(end.stderr, new RegExp(`job: stopped by ${signal}`, "u"));
    assert.ok(piCommands(place).some(({ type }) => type === "abort"));
    const ops = logOf(place, "ops.log");
    assert.deepEqual(
      ops.map(({ op }) => op),
      ["sweep", "claim", "save-state", "save-state"],
    );
    const [save] = ops.slice(-1);
    assert.equal(save.state.stage, "spec");
    assert.equal(save.state.lease, null);
    const status = statusOf(place);
    assert.deepEqual(status.outcome, { kind: "stopped", signal });
    assert.equal(sessionOf(status).outcome, null);
    assert.equal(fs.existsSync(status.socket), false);
  });
}

test("a session that ignores the abort is killed after the grace period, and the job still saves", async () => {
  const place = setUp(repliesAt("spec"), {
    events: ["wait"],
    ignoreAbort: true,
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(() => piCommands(place).some(({ type }) => type === "prompt"));
  const [{ pid }] = piStarts(place);
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(alive(pid), false);
  const ops = logOf(place, "ops.log").map(({ op }) => op);
  assert.deepEqual(ops, ["sweep", "claim", "save-state", "save-state"]);
});
