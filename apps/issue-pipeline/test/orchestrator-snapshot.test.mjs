// @ts-check
// The orchestrator's view of the queue (#234): the sweep's verdicts and each
// issue's saved state, and rule 2's job liveness from job.json and from the
// orchestrator's own start records.
import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import {
  cfg,
  deadPid,
  leaseOf,
  NOW,
  OTHERS_PID,
  openWith,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { readQueue } = await import("../src/orchestrator/snapshot.ts");

/** @import { StartRecord } from "../src/orchestrator/ledger.ts" */

const ISSUE = { fresh: 1, elsewhere: 2, after: 3, stopped: 4, mine: 5 };
const JOB = {
  running: 11,
  deadPid: 12,
  ended: 13,
  startedOnly: 14,
  startedDead: 15,
  others: 16,
};
const PR = 70;
const CLOSED = 99;

/** @param {number} issue @param {number} pid @returns {StartRecord} */
function started(issue, pid) {
  return { issue, stage: "spec", pid, at: NOW.toISOString() };
}

test("each open issue carries the sweep's verdict, its saved stage, files and PR, and its open after marks", () => {
  openWith([
    { number: ISSUE.fresh },
    {
      number: ISSUE.elsewhere,
      labels: ["agent:working"],
      state: {
        stage: "implement",
        files: ["src/a.ts"],
        pr: PR,
        lease: leaseOf("other"),
      },
      reads: 2,
    },
    {
      number: ISSUE.after,
      body: `<!-- agent-pipeline:after ${ISSUE.fresh},${CLOSED} -->`,
    },
    {
      number: ISSUE.stopped,
      labels: ["agent:stopped-error"],
      state: { stage: "fix" },
    },
    {
      number: ISSUE.mine,
      labels: ["agent:working"],
      state: { stage: "review", lease: leaseOf("orchestrator") },
      reads: 2,
    },
  ]);
  const { issues, jobs } = readQueue(cfg, [], NOW);
  const base = { files: null, pr: null, after: [], stopped: false, job: null };
  const facts = issues.map(({ createdAt: _, ...rest }) => rest);
  assert.deepEqual(facts, [
    {
      ...base,
      number: ISSUE.fresh,
      verdict: { kind: "candidate", answered: false },
      stage: null,
    },
    {
      ...base,
      number: ISSUE.elsewhere,
      verdict: { kind: "live-elsewhere", lane: "other" },
      stage: "implement",
      files: ["src/a.ts"],
      pr: PR,
    },
    {
      ...base,
      number: ISSUE.after,
      verdict: { kind: "waiting-on-after" },
      stage: null,
      after: [ISSUE.fresh],
    },
    {
      ...base,
      number: ISSUE.stopped,
      verdict: { kind: "skip" },
      stage: "fix",
      stopped: true,
    },
    {
      ...base,
      number: ISSUE.mine,
      verdict: { kind: "candidate", answered: false },
      stage: "review",
    },
  ]);
  assert.deepEqual(jobs, []);
});

test("a job is live while its job.json has no outcome and its pid runs, or while a job the orchestrator started runs", () => {
  const running = writeJob({
    issue: JOB.running,
    stage: "implement",
    pid: process.pid,
  });
  writeJob({ issue: JOB.deadPid, stage: "fix", pid: deadPid() });
  writeJob({
    issue: JOB.ended,
    stage: "review",
    pid: process.pid,
    ended: true,
  });
  writeJob({ issue: JOB.others, stage: "checks", pid: OTHERS_PID });
  const numbers = Object.values(JOB);
  openWith(numbers.map((number) => ({ number })));
  const starts = [
    started(JOB.startedOnly, process.pid),
    started(JOB.startedDead, deadPid()),
  ];
  const { issues, jobs } = readQueue(cfg, starts, NOW);
  assert.deepEqual(
    issues.map((issue) => [issue.number, issue.job]),
    [
      [JOB.running, { live: true, stage: "implement" }],
      [JOB.deadPid, { live: false, stage: "fix" }],
      [JOB.ended, { live: false, stage: "review" }],
      [JOB.startedOnly, { live: true, stage: "spec" }],
      [JOB.startedDead, null],
      [JOB.others, { live: true, stage: "checks" }],
    ],
  );
  // Every job.json goes to the ledger, the running one as written.
  assert.deepEqual(
    jobs.map((job) => job.issue),
    [JOB.running, JOB.deadPid, JOB.ended, JOB.others],
  );
  assert.deepEqual(jobs[0], running);
});
