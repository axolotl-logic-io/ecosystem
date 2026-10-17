// Steering a running stage job's session with --steer: the message reaches
// pi through the job's socket, the context log counts it, and every way it
// can't fails with exit 1.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { waitFor } from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  logOf,
  PASS_VERDICT,
  piCommands,
  repliesAt,
  runJob,
  SWEEP_SESSION,
  SWEEP_STAGE,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  USAGE,
} from "./job-test-kit.mjs";

/** @import { Place } from "./job-test-kit.mjs" */

const STAGE_ARGS = ["--stage", SWEEP_STAGE, "--lane", "L"];
const MESSAGE = "Look at src/b.ts too.";
// The launch key of an implementer session, a writer's.
const WRITER_KEY = /^i7-implement-\d+$/u;

/** @param {Place} place @param {string} key */
function steer(place, key) {
  return runJob(place, ["--steer", key, "--message", MESSAGE]);
}

/**
 * Waits for each marker of a session that can take a steer, in the order the
 * job writes them: its launch in job.json, the steer socket, and the prompt
 * in pi.log.
 * @param {Place} place
 * @returns {Promise<void>}
 */
async function steerable(place) {
  await waitFor(
    "the session's launch in job.json",
    () => sessionOf(statusOf(place)) !== null,
  );
  await waitFor("the steer socket", () =>
    fs.existsSync(statusOf(place).socket),
  );
  await waitFor("pi got the prompt", () =>
    piCommands(place).some(({ type }) => type === "prompt"),
  );
}

test("--steer sends the message to the live session, which carries on, and its context line counts the steer and keeps pi's cost and 1h cache writes", async () => {
  const place = setUp(repliesAt(SWEEP_STAGE), {
    events: ["wait", messageEnd(USAGE), outputEnd(PASS_VERDICT)],
  });
  const job = startJob(place, STAGE_ARGS);
  await steerable(place);
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
  const log = fs.readFileSync(path.join(place.runDir, "context.jsonl"), "utf8");
  const line = JSON.parse(log);
  assert.deepEqual(line.steers, { context: 0, socket: 1 });
  assert.deepEqual(line.usage, USAGE);
});

test("--steer reaches a live writer session too, as the wiki's Steering a running session says", async () => {
  const place = setUp(repliesAt("implement"), {
    events: ["wait", messageEnd(USAGE), outputEnd(PASS_VERDICT)],
  });
  const job = startJob(place, ["--stage", "implement"]);
  await steerable(place);
  const { key } = sessionOf(statusOf(place));
  assert.match(key, WRITER_KEY);
  const r = steer(place, key);
  assert.equal(r.status, 0, r.stderr);
  const steers = piCommands(place).filter(({ type }) => type === "steer");
  assert.deepEqual(
    steers.map(({ message }) => message),
    [MESSAGE],
  );
  assert.equal((await job.end).status, 0);
});

test("--steer with no running job exits 1 with the reason", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), SWEEP_SESSION);
  const before = steer(place, "i7-accept-3");
  assert.equal(before.status, 1);
  assert.notEqual(before.stderr, "");
  assert.equal(runJob(place, STAGE_ARGS).status, 0);
  const after = steer(place, sessionOf(statusOf(place)).key);
  assert.equal(after.status, 1);
  assert.notEqual(after.stderr, "");
});

test("--steer can't be combined with --resume", () => {
  const place = setUp(repliesAt(SWEEP_STAGE), SWEEP_SESSION);
  const r = runJob(place, ["--steer", "k", "--message", "m", "--resume"]);
  assert.equal(r.status, 1);
  assert.notEqual(r.stderr, "");
  assert.deepEqual(logOf(place, "ops.log"), []);
});
