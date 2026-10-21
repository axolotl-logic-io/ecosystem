// @ts-check
// The orchestrator's scheduler on recorded queue snapshots: the four stages
// start up to the live-job caps, new trusted input sends an issue back to the
// author, needs-info and after marks hold, one merge window keeps its holder
// while its changed head is reviewed again, a dead job restarts a bounded
// number of times, and a legacy job holds its issue without being counted
// as this pipeline's.
import assert from "node:assert/strict";
import { test } from "node:test";
// The fixtures set a temporary HOME and pipeline root before they load the
// scheduler.
import {
  decided,
  failedAt,
  HOUR_MS,
  jobAt,
  NOW,
  SETTINGS,
  scheduled,
  snapshotOf,
} from "./orchestrator-fixtures.mjs";

// An open issue the after mark names.
const PREREQ = 9;

test("each stage starts, later stages first, then older issues", () => {
  const snapshot = snapshotOf([
    { number: 1 },
    { number: 2, stage: "implement" },
    { number: 3, stage: "review" },
    { number: 4, stage: "merge", pr: 40 },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#4 merge started free [4]",
    "#3 review started free",
    "#1 implement started free",
    "#2 implement started free",
  ]);
});

test("starts past maxJobs hold at the global cap, counting live jobs", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "implement", job: jobAt("implement", "live") },
    { number: 2, stage: "implement", job: jobAt("implement", "live") },
    { number: 3, stage: "implement", job: jobAt("implement", "live") },
    { number: 4, stage: "implement" },
    { number: 5, stage: "implement" },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#4 implement started free",
    "#5 implement held global-cap",
  ]);
});

test("starts past a stage's cap hold, and a legacy live job counts toward maxJobs", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "review", job: jobAt("review", "live") },
    { number: 2, stage: "review" },
    { number: 3, stage: "review" },
    { number: 4, legacyLive: true, stage: "implement" },
    { number: 5, stage: "implement" },
    { number: 6, stage: "implement" },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#2 review started free",
    "#3 review held stage-cap",
    "#4 implement held legacy-job-live",
    "#5 implement started free",
    "#6 implement held global-cap",
  ]);
});

test("an open prerequisite in the after mark holds, and another lane's live lease holds", () => {
  const lease = { lane: "sweep-a", sweepId: "x", at: NOW.toISOString() };
  const stale = new Date(NOW.getTime() - SETTINGS.leaseMs - HOUR_MS);
  const snapshot = snapshotOf([
    { number: 1, stage: "implement", after: [PREREQ] },
    { number: 2, stage: "implement", state: { lease } },
    {
      number: 3,
      stage: "implement",
      state: { lease: { ...lease, lane: "orchestrator" } },
    },
    {
      number: 4,
      stage: "implement",
      state: { lease: { ...lease, at: stale.toISOString() } },
    },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 implement held after:#9",
    "#2 implement held lease:sweep-a",
    "#3 implement started free",
    "#4 implement started free",
  ]);
});

test("stop labels, merged, split, skipLabels, untrusted authors, done, live jobs and new work off get no decision", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "implement", labels: ["agent:stopped-error"] },
    { number: 2, stage: "merge", labels: ["agent:merged"] },
    { number: 3, labels: ["agent:split"] },
    { number: 4, stage: "implement", labels: ["wontfix"] },
    { number: 5, authorAllowed: false },
    { number: 6, stage: "done" },
    { number: 7, stage: "review", job: jobAt("review", "live") },
    { number: 8 },
  ]);
  const settings = { ...SETTINGS, takeNewWork: false };
  assert.deepEqual(decided(snapshot, { settings }), []);
});

test("a stopped issue whose stop label is gone starts at the stage it stopped in", () => {
  const snapshot = snapshotOf([
    {
      number: 1,
      stage: "stopped",
      state: { stoppedStage: "review", stopCode: "error" },
    },
  ]);
  assert.deepEqual(decided(snapshot), ["#1 review started lifted"]);
});

test("changed trusted input sends implement back to implement and review or merge back to review", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "implement", gherkin: "inputs-0" },
    { number: 2, stage: "review", gherkin: "inputs-0" },
    { number: 3, stage: "merge", gherkin: "inputs-0" },
    { number: 4, stage: "review", gherkin: null },
    { number: 5, stage: "review" },
  ]);
  const settings = { ...SETTINGS, maxJobs: 9, stageCaps: {} };
  const starts = scheduled(snapshot, { settings }).decisions.map((decision) => {
    assert.equal(decision.action, "started");
    return `#${decision.issue} ${decision.stage} ${decision.reason} ${decision.reauthor?.resumeStage}`;
  });
  assert.deepEqual(starts, [
    "#5 review free undefined",
    "#1 author reauthor implement",
    "#2 author reauthor review",
    "#3 author reauthor review",
    "#4 author reauthor review",
  ]);
});

test("needs-info holds while the input is the one asked on, and the author starts once it changes", () => {
  const asked = {
    stage: /** @type {const} */ ("author"),
    labels: ["agent:needs-info"],
  };
  const snapshot = snapshotOf([
    { number: 1, ...asked, asked: "inputs-1" },
    { number: 2, ...asked, asked: "inputs-0" },
    // A needs-info issue from before `asked` existed gets one author run.
    { number: 3, ...asked, asked: null },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#1 author held needs-info",
    "#2 author started free",
    "#3 author started free",
  ]);
});

test("the merge window's holder keeps it while its changed head is reviewed again", () => {
  const snapshot = snapshotOf(
    [
      { number: 1, stage: "merge", pr: 10 },
      { number: 2, stage: "review", pr: 20 },
    ],
    2,
  );
  assert.deepEqual(decided(snapshot), [
    "#2 review started free",
    "#1 merge held merge-window:#2",
  ]);
  const { memory } = scheduled(snapshot);
  assert.equal(memory.mergeWindow, 2);
});

test("with no holder the merge most issues wait on opens the window, then the lower PR", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "merge", pr: 10 },
    { number: 2, stage: "merge", pr: 30 },
    { number: 3, stage: "merge", pr: 20 },
    { number: 4, stage: "implement", after: [2] },
  ]);
  assert.deepEqual(decided(snapshot), [
    "#2 merge started free [2,1,3]",
    "#1 merge held merge-window:#2",
    "#3 merge held merge-window:#2",
    "#4 implement held after:#2",
  ]);
  assert.equal(scheduled(snapshot).memory.mergeWindow, 2);
});

test("a live merge job holds the window, and a holder sent back to the author gives it up", () => {
  const live = snapshotOf([
    { number: 1, stage: "merge", job: jobAt("merge", "live") },
    { number: 2, stage: "merge" },
  ]);
  assert.deepEqual(decided(live), ["#2 merge held merge-window:#1"]);
  const reauthored = snapshotOf(
    [
      { number: 1, stage: "review", gherkin: "inputs-0" },
      { number: 2, stage: "merge" },
    ],
    1,
  );
  assert.deepEqual(decided(reauthored), [
    "#2 merge started free [2]",
    "#1 author started reauthor",
  ]);
});

test("a dead job restarts at its stage up to maxResumes, then the issue stops", () => {
  const died = jobAt("review", null);
  const snapshot = snapshotOf([
    { number: 1, stage: "review", job: died },
    {
      number: 2,
      stage: "implement",
      job: jobAt("implement", failedAt(NOW.toISOString())),
    },
    { number: 3, stage: "review", job: jobAt("implement", null) },
  ]);
  const first = scheduled(snapshot);
  assert.deepEqual(
    first.decisions.map(
      ({ issue, action, reason }) => `#${issue} ${action} ${reason}`,
    ),
    ["#1 started restart", "#3 started free", "#2 started restart"],
  );
  assert.deepEqual(first.memory.resumes, { "1 review": 1, "2 implement": 1 });
  const resumes = { "1 review": 2 };
  const last = scheduled(
    snapshotOf([{ number: 1, stage: "review", job: died }]),
    {
      resumes,
    },
  );
  assert.deepEqual(
    last.decisions.map(({ action, reason }) => `${action} ${reason}`),
    ["stopped max-resumes"],
  );
  assert.deepEqual(last.memory.resumes, {});
});

test("a backoff holds every start and admits no restart", () => {
  const snapshot = snapshotOf([
    { number: 1, stage: "merge" },
    { number: 2, stage: "review", job: jobAt("review", null) },
  ]);
  const run = { gate: "rate-limited" };
  assert.deepEqual(decided(snapshot, run), [
    "#1 merge held rate-limited",
    "#2 review held rate-limited",
  ]);
  assert.deepEqual(scheduled(snapshot, run).memory.resumes, {});
});
