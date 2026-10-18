// @ts-check
// The orchestrator's file gate (#390): an implement waits on the oldest live
// implementation whose branch changes one of its stub files, the `where` of
// its `new` interfaces. Nothing else is held on files: an issue with no stub
// files, a fix, sync or checks, an issue and its prerequisite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { schedule, startGate } from "../src/orchestrator/schedule.ts";
import { issue, NOW, SETTINGS, snapshotOf } from "./orchestrator-fixtures.mjs";

/** @import { Snapshot } from "../src/orchestrator/queue.ts" */

const STUB = "apps/issue-pipeline/src/orchestrator/branch-changes.ts";
const OTHER_FILE = "apps/issue-pipeline/src/orchestrator/snapshot.ts";
const ACCEPT_JOB = { live: true, stage: "accept" };
const REVIEW_JOB = { live: true, stage: "review" };

// Each decision as `#issue stage action reason`, in the order made.
/** @param {Snapshot} snapshot @returns {string[]} */
function decided(snapshot) {
  return schedule(snapshot, SETTINGS, NOW).map(
    ({ issue: number, stage, action, reason }) =>
      `#${number} ${stage} ${action} ${reason}`,
  );
}

test("an implement is held by the oldest of the live branches that change its stub", () => {
  const snapshot = snapshotOf([
    issue({ number: 3, stage: "review", job: REVIEW_JOB, changed: [STUB] }),
    issue({ number: 2, stage: "accept", job: ACCEPT_JOB, changed: [STUB] }),
    issue({ number: 1, stage: "checks", job: ACCEPT_JOB, changed: ["a.ts"] }),
    issue({ number: 5, stage: "implement", stubs: [OTHER_FILE, STUB] }),
  ]);
  assert.deepEqual(decided(snapshot), ["#5 implement held files-overlap:#2"]);
});

test("an implement whose stubs no live branch changes starts, whatever else they change", () => {
  const snapshot = snapshotOf([
    issue({
      number: 2,
      stage: "review",
      job: REVIEW_JOB,
      changed: [OTHER_FILE, "README.md"],
    }),
    issue({ number: 3, stage: "implement", stubs: [STUB] }),
  ]);
  assert.deepEqual(decided(snapshot), ["#3 implement started free"]);
});

test("an implement with no stub files starts beside live implementations", () => {
  const snapshot = snapshotOf([
    issue({ number: 2, stage: "review", job: REVIEW_JOB, changed: [STUB] }),
    issue({ number: 3, stage: "fix", job: REVIEW_JOB, changed: null }),
    issue({ number: 4, stage: "implement" }),
  ]);
  assert.deepEqual(decided(snapshot), ["#4 implement started free"]);
});

test("a live implementation whose branch wasn't read holds no implement", () => {
  const snapshot = snapshotOf([
    issue({ number: 2, stage: "review", job: REVIEW_JOB, changed: null }),
    issue({ number: 3, stage: "implement", stubs: [STUB] }),
  ]);
  assert.deepEqual(decided(snapshot), ["#3 implement started free"]);
});

test("an implement started in the same tick has no changed files yet, so it holds no other", () => {
  const snapshot = snapshotOf([
    issue({ number: 2, stage: "implement", stubs: [STUB] }),
    issue({ number: 3, stage: "implement", stubs: [STUB] }),
  ]);
  assert.deepEqual(decided(snapshot), [
    "#2 implement started free",
    "#3 implement started free",
  ]);
});

// The writer, and the older live implementation it is behind.
const WRITER = 3;
const AHEAD = 2;

// AHEAD, a live implementation at accept, ranked first by its lower PR, whose
// branch changes the stub of WRITER, which is at `stage` and changes it too.
/** @param {string} stage @returns {Snapshot} */
function writerBehind(stage) {
  return snapshotOf([
    issue({
      number: AHEAD,
      stage: "accept",
      pr: 10,
      job: ACCEPT_JOB,
      changed: [STUB],
    }),
    issue({ number: WRITER, stage, pr: 20, stubs: [STUB], changed: [STUB] }),
  ]);
}

for (const stage of ["fix", "sync", "checks"]) {
  test(`a ${stage} start or restart is never held on files`, () => {
    assert.deepEqual(decided(writerBehind(stage)), [
      `#${WRITER} ${stage} started free`,
    ]);
    const gate = startGate(writerBehind(stage), SETTINGS);
    assert.equal(gate(WRITER, stage), null);
  });
}

test("an implement restart is held by the live branch that changes its stub", () => {
  const gate = startGate(writerBehind("implement"), SETTINGS);
  assert.equal(gate(WRITER, "implement"), `files-overlap:#${AHEAD}`);
});
