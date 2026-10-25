// Stopping a stage job with SIGTERM or SIGINT: it aborts its pi sessions,
// ends its running ops' process groups (#371), saves the issue at its stage
// with no lease, logs the aborted session as killed, and exits 128 + the
// signal.
import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import { test } from "node:test";
import type { LaunchRecord } from "../../src/job/launch-record.ts";
import {
  alive,
  endsWithTest,
  killGroup,
  pidIn,
  waitFor,
} from "../bounded-test-kit.ts";
import { messageEnd, outputEnd } from "../fake-rpc-pi.ts";
import { AUTHORED, READER_STAGE, repliesAt, USAGE } from "../job-fixtures.ts";
import type { OpsLine, Place } from "./job-test-kit.ts";
import {
  logOf,
  piCommands,
  piStarts,
  sessionOf,
  setUp,
  startJob,
  statusOf,
} from "./job-test-kit.ts";

const STAGE_ARGS: string[] = ["--stage", READER_STAGE, "--lane", "L"];
// Where the fakes write the pids of the sleeps they start.
const HANG_PID = "hang.pid";
const PI_CHILD_PID = "pi-child.pid";
// 128 + each signal's number.
const STOPPED_BY_SIGTERM = 143;
const STOPPED_BY_SIGINT = 130;
const SIGNAL_CODES: [NodeJS.Signals, number][] = [
  ["SIGTERM", STOPPED_BY_SIGTERM],
  ["SIGINT", STOPPED_BY_SIGINT],
];

// A stop saves the issue at its stage with no lease, through save-state only.
const SAVED_AT_STAGE: {
  released: boolean;
  saved: { stage: string; lease: null };
} = {
  released: false,
  saved: { stage: READER_STAGE, lease: null },
};

// What a test reads of a context.jsonl line: how its session ended and what
// it spent.
interface ContextEnd {
  ended: string;
  usage: object;
}

// Whether the stopped job released the issue, which would renew its lease,
// and the state it last saved through save-state.
function stopSaveOf(place: Place): {
  released: boolean;
  saved: { stage: unknown; lease: unknown };
} {
  const ops = logOf<OpsLine>(place, "ops.log");
  const [save] = ops.filter(({ op }) => op === "save-state").slice(-1);
  return {
    released: ops.some(({ op }) => op === "release"),
    saved: { stage: save?.state?.stage, lease: save?.state?.lease },
  };
}

for (const [signal, code] of SIGNAL_CODES) {
  test(`${signal} aborts the session, saves the issue at its stage with no lease and exits ${code}`, async () => {
    const place = setUp(repliesAt(READER_STAGE), {
      events: [messageEnd(USAGE), "wait", outputEnd(AUTHORED)],
    });
    const job = startJob(place, STAGE_ARGS);
    await waitFor(
      "the session's usage in job.json",
      () => (sessionOf(statusOf(place))?.usage.input ?? 0) > 0,
    );
    job.child.kill(signal);
    const end = await job.end;
    assert.equal(end.status, code, end.stderr);
    assert.equal(end.stdout, "");
    assert.match(end.stderr, new RegExp(`job: stopped by ${signal}`, "u"));
    assert.ok(piCommands(place).some(({ type }) => type === "abort"));
    assert.deepEqual(stopSaveOf(place), SAVED_AT_STAGE);
    const status = statusOf(place);
    assert.deepEqual(status?.outcome, { kind: "stopped", signal });
    // The aborted session's result went back to the role as a failure, and
    // its context line says the stop killed it.
    assert.equal(sessionOf(status)?.outcome, "failed");
    const [line] = logOf<ContextEnd>(place, "runs/o__r/issue-7/context.jsonl");
    assert.equal(line?.ended, "killed");
    assert.deepEqual(line.usage, USAGE);
    assert.equal(fs.existsSync(status.socket), false);
  });
}

// Returns the job's first launch, or null
function firstLaunchOf(place: Place): LaunchRecord | null {
  return statusOf(place)?.launches[0] ?? null;
}

test("a stop kills the process group of an ops launch still running (#371)", async () => {
  const replies = repliesAt(READER_STAGE);
  const hung = { ...replies, claim: { ...replies.claim, hang: true } };
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
  await waitFor(
    "the hung op's sleep",
    () => pidIn(place.root, HANG_PID) !== null,
  );
  const sleep = pidIn(place.root, HANG_PID);
  const ops = firstLaunchOf(place);
  assert.equal(ops?.kind, "ops");
  job.child.kill("SIGTERM");
  await waitFor("the job to exit", () => exited);
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  const { pid } = ops;
  assert.equal(pid !== null && alive(pid), false);
  await waitFor("the op's sleep to end", () => !alive(sleep ?? 0));
});

test("a session killed after the grace period loses its whole process group (#371)", async () => {
  const place = setUp(repliesAt(READER_STAGE), {
    events: ["wait"],
    ignoreAbort: true,
    child: true,
  });
  const job = startJob(place, STAGE_ARGS);
  endsWithTest(() => {
    const sleep = pidIn(place.root, PI_CHILD_PID);
    if (sleep !== null && alive(sleep)) {
      process.kill(sleep, "SIGKILL");
    }
  });
  await waitFor("pi's child", () => pidIn(place.root, PI_CHILD_PID) !== null);
  const sleep = pidIn(place.root, PI_CHILD_PID);
  if (sleep === null) {
    throw new Error("pi-child.pid has no pid");
  }
  const [start] = piStarts(place);
  assert.ok(start);
  const { pid } = start;
  job.child.kill("SIGTERM");
  const end = await job.end;
  assert.equal(end.status, STOPPED_BY_SIGTERM, end.stderr);
  assert.equal(alive(pid), false);
  assert.deepEqual(stopSaveOf(place), SAVED_AT_STAGE);
  await waitFor("pi's child to end", () => !alive(sleep));
});
