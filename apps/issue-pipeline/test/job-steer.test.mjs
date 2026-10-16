// Steering a running stage job's session with --steer: the message reaches
// pi through the job's socket, and every way it can't fails with exit 1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  logOf,
  piCommands,
  READY_SPEC,
  repliesAt,
  runJob,
  SPEC_SESSION,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  USAGE,
  waitFor,
} from "./job-test-kit.mjs";

const STAGE_ARGS = ["--stage", "spec", "--lane", "L"];
const MESSAGE = "Look at src/b.ts too.";

/** @param {import("./job-test-kit.mjs").Place} place @param {string} key */
function steer(place, key) {
  return runJob(place, ["--steer", key, "--message", MESSAGE]);
}

test("--steer sends the message to the live session, which carries on", async () => {
  const place = setUp(repliesAt("spec"), {
    events: ["wait", messageEnd(USAGE), outputEnd(READY_SPEC)],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(() => piCommands(place).some(({ type }) => type === "prompt"));
  const { key } = sessionOf(statusOf(place));
  const missing = steer(place, "i7-nope-1");
  assert.equal(missing.status, 1);
  assert.notEqual(missing.stderr, "");
  const r = steer(place, key);
  assert.equal(r.status, 0, r.stderr);
  const steers = piCommands(place).filter(({ type }) => type === "steer");
  assert.deepEqual(
    steers.map(({ message }) => message),
    [MESSAGE],
  );
  const end = await job.end;
  assert.equal(end.status, 0, end.stderr);
  const ops = logOf(place, "ops.log").map(({ op }) => op);
  assert.ok(ops.includes("release"));
});

test("--steer with no running job exits 1 with the reason", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const before = steer(place, "i7-spec-3");
  assert.equal(before.status, 1);
  assert.notEqual(before.stderr, "");
  assert.equal(runJob(place, STAGE_ARGS).status, 0);
  const after = steer(place, sessionOf(statusOf(place)).key);
  assert.equal(after.status, 1);
  assert.notEqual(after.stderr, "");
});

test("--steer can't be combined with --resume", () => {
  const place = setUp(repliesAt("spec"), SPEC_SESSION);
  const r = runJob(place, ["--steer", "k", "--message", "m", "--resume"]);
  assert.equal(r.status, 1);
  assert.notEqual(r.stderr, "");
  assert.deepEqual(logOf(place, "ops.log"), []);
});
