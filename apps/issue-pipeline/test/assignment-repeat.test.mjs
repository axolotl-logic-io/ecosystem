// @ts-check
// Repeated assignment sweeps with durable holds (#174). A job started for
// an assignment that defers records a hold on the issue; no later sweep
// starts the same work again while it holds, not even a new sweep process
// with a new run folder. The retry time passing lifts it, and so does a
// person's comment. The installed sweep, launcher, job and ops run for real
// against the fake GitHub, a local origin and fake pi.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GRANTOR,
  HIPPY,
  optIn,
  pipelineComments,
  runFolder,
  startedJobs,
  sweep,
} from "./assignment-test-kit.mjs";
import { humanComment } from "./fake-pipeline-flow-gh.mjs";
import { assignIssue } from "./fake-pipeline-flow-gh-assignments.mjs";
import { withWorld } from "./fake-pipeline-flow-gh-world.mjs";
import { piLog } from "./fake-pipeline-flow-pi.mjs";
import {
  implementorTurn,
  openFlowIssue,
} from "./pipeline-flow-script-test-kit.mjs";
import { ISSUE, scriptPi, setUpFlow } from "./pipeline-flow-test-kit.mjs";

const HOLD_MARK = "<!-- issue-pipeline:assignment-hold\n";
const INTERRUPTED = { output: {}, rejectPrompt: "read ECONNRESET" };
const NOT_STARTED = /^(?:refused: |held since )/u;
const HELD = /^held since .+ \(until .+\)$/u;
const LONG_AGO = "2000-01-01T00:00:00.000Z";
// Two deferred sessions and the one that finishes.
const ALL_SESSIONS = 3;

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function holdRecords(flow) {
  return pipelineComments(flow)
    .filter((body) => body.includes(HOLD_MARK))
    .map((body) => {
      const start = body.indexOf(HOLD_MARK) + HOLD_MARK.length;
      return JSON.parse(body.slice(start, body.indexOf("\n-->", start)));
    });
}

/** @param {import("./pipeline-flow-test-kit.mjs").Flow} flow */
function sessionCount(flow) {
  return piLog(flow.piDir).filter((entry) => entry.start === true).length;
}

/** @param {any[]} decisions @param {number} at */
function issueAt(decisions, at) {
  return decisions.find((each) => each.sweep === at && each.issue === ISSUE);
}

/**
 * Moves the hold record's retry time into the past, as time passing would.
 * @param {import("./pipeline-flow-test-kit.mjs").Flow} flow
 */
function passRetryTime(flow) {
  withWorld(flow.ghDir, (world) => {
    for (const each of world.comments) {
      const start = each.body.indexOf(HOLD_MARK);
      if (start >= 0) {
        const from = start + HOLD_MARK.length;
        const end = each.body.indexOf("\n-->", from);
        const record = JSON.parse(each.body.slice(from, end));
        record.retryAt = LONG_AGO;
        each.body = `${each.body.slice(0, from)}${JSON.stringify(record)}${each.body.slice(end)}`;
      }
    }
  });
}

test("repeated sweeps start nothing twice, a deferral's hold survives a restart, and retry time or a person lifts it", async () => {
  const flow = setUpFlow();
  optIn(flow);
  openFlowIssue(flow, "alice", "Greet politely", "Say hello to visitors.");
  assignIssue(flow.ghDir, ISSUE, HIPPY, GRANTOR);
  scriptPi(flow, {
    implementor: [
      INTERRUPTED,
      INTERRUPTED,
      implementorTurn("Hello, world!", "Greet visitors"),
    ],
  });
  const before = runFolder(flow, { maxJobs: 1 });
  const first = sweep(flow, before, ["--sweeps", "2", "--interval", "0"]);
  assert.equal(issueAt(first, 1).start.stage, "implement");
  assert.match(issueAt(first, 2).hold, NOT_STARTED, "no second start");
  const [deferred] = await startedJobs(flow, first);
  assert.equal(deferred?.line.end, "deferred");
  const [record] = holdRecords(flow);
  assert.equal(record.work, "implement");
  assert.equal(record.end, "deferred");
  assert.equal(record.count, 1);
  assert.equal(sessionCount(flow), 1);

  // A restart: a new sweep process and a new run folder.
  const after = runFolder(flow, { maxJobs: 1 });
  const restarted = sweep(flow, after);
  assert.match(issueAt(restarted, 1).hold, HELD);
  assert.equal(sessionCount(flow), 1, "the hold survived the restart");

  passRetryTime(flow);
  const retried = sweep(flow, after);
  assert.equal(issueAt(retried, 1).start.stage, "implement");
  await startedJobs(flow, retried);
  const again = holdRecords(flow);
  assert.equal(again.length, 1, "one record, edited in place");
  assert.equal(again[0].count, 2, "the next deferral doubles the wait");
  assert.match(issueAt(sweep(flow, after), 1).hold, HELD);

  humanComment(flow.ghDir, ISSUE, "alice", "Please try again.");
  const lifted = sweep(flow, after);
  assert.equal(issueAt(lifted, 1).start.stage, "implement");
  const [done] = await startedJobs(flow, lifted);
  assert.equal(done?.line.end, "next");
  assert.equal(sessionCount(flow), ALL_SESSIONS);
});
