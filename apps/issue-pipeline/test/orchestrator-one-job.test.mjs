// @ts-check
// The orchestrator and one implementor job that runs fix then checks (#424,
// `implementor-one-job`): the snapshot reads the stage a live job's job.json
// names now, so the job counts once toward maxJobs and toward that stage's
// cap, and its issue gets no decision; a job.json from before #424, which
// names only the stage its job started at, still reads; and a dead job that
// moved on is restarted at the stage it moved to.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { issue, NOW, SETTINGS, snapshotOf } from "./orchestrator-fixtures.mjs";
import { tickOver } from "./orchestrator-watchdog-test-kit.mjs";
import {
  cfg,
  deadPid,
  openWith,
  writeJob,
} from "./orchestrator-world-test-kit.mjs";

const { paths } = await import("../src/config.ts");
const { readQueue } = await import("../src/orchestrator/snapshot.ts");
const { schedule } = await import("../src/orchestrator/schedule.ts");

/** @import { ScheduleSettings } from "../src/orchestrator/queue.ts" */

const ISSUE = { moved: 80, atFix: 81, atChecks: 82, older: 83, dead: 84 };
// Room for the live job and one more, and one job each at fix and checks.
/** @type {ScheduleSettings} */
const TIGHT = {
  ...SETTINGS,
  maxJobs: 2,
  stageCaps: { ...SETTINGS.stageCaps, fix: 1, checks: 1 },
};

// Writes issue `number`'s job.json, started at fix, as a job that moved on
// to checks writes it; `pid` is the job's process.
/** @param {number} number @param {number} pid */
function movedToChecks(number, pid) {
  const status = { ...writeJob({ issue: number, stage: "fix", pid }) };
  const file = path.join(paths.runDir(cfg, number), "job.json");
  fs.writeFileSync(file, JSON.stringify({ ...status, currentStage: "checks" }));
}

test("a live job that moved from fix to checks counts once, toward the checks cap, and its issue gets no decision", () => {
  movedToChecks(ISSUE.moved, process.pid);
  openWith([{ number: ISSUE.moved, state: { stage: "checks", pr: 1 } }]);
  const [moved] = readQueue(cfg, [], NOW).issues;
  assert.deepEqual(moved?.job, { live: true, stage: "checks" });
  const snapshot = snapshotOf([
    issue({ number: ISSUE.moved, stage: "fix", job: moved?.job ?? null }),
    issue({ number: ISSUE.atFix, stage: "fix", pr: 2 }),
    issue({ number: ISSUE.atChecks, stage: "checks", pr: 3 }),
  ]);
  const decided = schedule(snapshot, TIGHT, NOW).map(
    ({ issue: number, stage, action, reason }) =>
      `#${number} ${stage} ${action} ${reason}`,
  );
  assert.deepEqual(decided, [
    `#${ISSUE.atChecks} checks held stage-cap`,
    `#${ISSUE.atFix} fix started free`,
  ]);
});

test("an older job.json, which names only the stage its job started at, still reads at that stage", async () => {
  const { readStatus } = await import("../src/job/status.ts");
  writeJob({ issue: ISSUE.older, stage: "fix", pid: process.pid });
  openWith([{ number: ISSUE.older, state: { stage: "fix", pr: 1 } }]);
  const status = readStatus(paths.runDir(cfg, ISSUE.older));
  assert.equal(status?.stage, "fix");
  assert.equal(status?.currentStage, undefined);
  const [older] = readQueue(cfg, [], NOW).issues;
  assert.deepEqual(older?.job, { live: true, stage: "fix" });
});

test("a dead job that moved from fix to checks is restarted at checks", () => {
  movedToChecks(ISSUE.dead, deadPid());
  const { spawned } = tickOver([
    { number: ISSUE.dead, state: { stage: "checks", pr: 1 } },
  ]);
  const [argv, ...more] = spawned;
  assert.deepEqual(more, []);
  const stageAt = argv?.indexOf("--stage") ?? -1;
  assert.equal(argv?.[stageAt + 1], "checks");
});
