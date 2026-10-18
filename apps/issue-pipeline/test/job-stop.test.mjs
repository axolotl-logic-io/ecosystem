// Stopping a stage job with SIGTERM or SIGINT: it aborts its pi sessions,
// ends its running ops' process groups (#371), saves the issue at its stage
// with no lease, and exits 128 + the signal.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  alive,
  endsWithTest,
  killGroup,
  waitFor,
} from "./bounded-test-kit.mjs";
import { messageEnd, outputEnd } from "./fake-rpc-pi.mjs";
import {
  CLEAN_REVIEW,
  logOf,
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
// Where the fakes write the pids of the sleeps they start.
const HANG_PID = "hang.pid";
const PI_CHILD_PID = "pi-child.pid";
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
      events: [messageEnd(USAGE), "wait", outputEnd(CLEAN_REVIEW)],
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

/** @param {import("./job-test-kit.mjs").Place} place @param {string} name @returns {number | null} the pid in file `name` under the place's root, once written */
function pidIn(place, name) {
  const file = path.join(place.root, name);
  if (!fs.existsSync(file)) {
    return null;
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.endsWith("\n")) {
    return null;
  }
  return Number(text);
}

/** @param {import("./job-test-kit.mjs").Place} place @returns {any} the job's first launch, or null */
function firstLaunchOf(place) {
  return statusOf(place)?.launches[0] ?? null;
}

test("a stop kills the process group of an ops launch still running (#371)", async () => {
  const replies = repliesAt(SWEEP_STAGE);
  const { sweep } = replies;
  const hung = {
    ...replies,
    sweep: { .../** @type {object} */ (sweep), hang: true },
  };
  const place = setUp(hung, { events: ["wait"] });
  const job = startJob(place, STAGE_ARGS);
  let exited = false;
  job.child.on("close", () => {
    exited = true;
  });
  endsWithTest(() => {
    job.child.kill("SIGKILL");
    const pid = firstLaunchOf(place)?.pid;
    if (typeof pid === "number") {
      killGroup(pid);
    }
  });
  await waitFor("the hung op's sleep", () => pidIn(place, HANG_PID) !== null);
  const sleep = pidIn(place, HANG_PID);
  const ops = firstLaunchOf(place);
  assert.equal(ops?.kind, "ops");
  job.child.kill("SIGTERM");
  await waitFor("the job to exit", () => exited);
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(alive(ops.pid), false);
  await waitFor("the op's sleep to end", () => !alive(sleep ?? 0));
});

test("a session killed after the grace period loses its whole process group (#371)", async () => {
  const place = setUp(repliesAt(SWEEP_STAGE), {
    events: ["wait"],
    ignoreAbort: true,
    child: true,
  });
  const job = startJob(place, STAGE_ARGS);
  endsWithTest(() => {
    const sleep = pidIn(place, PI_CHILD_PID);
    if (sleep !== null && alive(sleep)) {
      process.kill(sleep, "SIGKILL");
    }
  });
  await waitFor("pi's child", () => pidIn(place, PI_CHILD_PID) !== null);
  const sleep = pidIn(place, PI_CHILD_PID);
  if (sleep === null) {
    throw new Error("pi-child.pid has no pid");
  }
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  await waitFor("pi's child to end", () => !alive(sleep));
});
