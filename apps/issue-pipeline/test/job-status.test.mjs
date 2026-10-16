// A stage job's status file, runs/<slug>/issue-N/job.json: what it shows
// while a session runs and once the job has finished.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { messageEnd, outputEnd, toolEnd } from "./fake-rpc-pi.mjs";
import {
  piStarts,
  READY_SPEC,
  repliesAt,
  runJob,
  sessionOf,
  setUp,
  startJob,
  statusOf,
  USAGE,
  waitFor,
} from "./job-test-kit.mjs";
import { ISSUE } from "./workflow-stages-fixtures.mjs";

const STAGE_ARGS = ["--stage", "spec", "--lane", "L"];

test("while a session waits, job.json shows its pid, session, last event and tool failures", async () => {
  const place = setUp(repliesAt("spec"), {
    events: [toolEnd(true), toolEnd(true), "wait"],
  });
  const job = startJob(place, STAGE_ARGS);
  await waitFor(() => sessionOf(statusOf(place))?.toolFailures === 2);
  const status = statusOf(place);
  assert.equal(status.version, 1);
  assert.equal(status.pid, job.child.pid);
  assert.equal(status.issue, ISSUE);
  assert.equal(status.stage, "spec");
  assert.equal(status.lane, "L");
  assert.equal(status.outcome, null);
  assert.ok(Date.parse(status.startedAt) > 0);
  const launch = sessionOf(status);
  const [start] = piStarts(place);
  assert.equal(launch.pid, start.pid);
  assert.equal(launch.session, start.argv[start.argv.indexOf("--session") + 1]);
  assert.ok(Date.parse(launch.lastEventAt) > 0);
  assert.equal(launch.outcome, null);
  assert.equal(launch.resumed, false);
  job.child.kill("SIGTERM");
  await job.end;
});

test("a finished job's file counts only the last tool failures and records each outcome", () => {
  const place = setUp(repliesAt("spec"), {
    events: [
      toolEnd(true),
      toolEnd(true),
      outputEnd(READY_SPEC),
      toolEnd(true),
      messageEnd(USAGE),
    ],
  });
  const r = runJob(place, STAGE_ARGS);
  assert.equal(r.status, 0, r.stderr);
  const status = statusOf(place);
  assert.equal(status.outcome.kind, "finished");
  assert.ok(Date.parse(status.endedAt) > 0);
  const launch = sessionOf(status);
  assert.equal(launch.toolFailures, 1);
  assert.equal(launch.outcome, "ok");
  assert.deepEqual(launch.usage, USAGE);
  const ops = status.launches.filter(
    (/** @type {{ kind: string }} */ { kind }) => kind === "ops",
  );
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.equal(op.session, null);
    assert.equal(op.outcome, "ok");
  }
  assert.deepEqual(fs.readdirSync(place.runDir).sort(), [
    "job.json",
    "sessions",
  ]);
});
