// @ts-check
// The scheduler's completion reconciliation (src/orchestrator/schedule.ts,
// issue-plan.ts; `completion-reconciliation`): an open issue saved done with
// what merged runs a merge job, with or without agent:merged and despite an
// open prerequisite, within the merge window and the caps; a plain done, a
// stopped completion and one with a live job run nothing. The pipeline root
// is a temporary one before src/ loads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedOpsFixture } from "./integration-source-test-kit.mjs";

await isolatedOpsFixture("integration-source-schedule");
const { newIssueState } = await import("../src/state.ts");
const { schedule } = await import("../src/orchestrator/schedule.ts");

/** @import { IssueState } from "../src/state.ts" */
/** @import { SnapshotIssue, ScheduleSettings } from "../src/orchestrator/queue.ts" */

const ISSUE = {
  completion: 51,
  mergedLabel: 52,
  prerequisite: 53,
  plainDone: 54,
  stopped: 55,
  liveJob: 56,
  reviewing: 61,
  waiting: 62,
  capped: 63,
  overGlobalCap: 64,
};
// The open issue a completion's after mark names.
const OPEN_PREREQUISITE = 99;
const SHA_LENGTH = 40;
const MERGE_COMMIT = "c".repeat(SHA_LENGTH);
const RECEIPT = {
  code: MERGE_COMMIT,
  wiki: "d".repeat(SHA_LENGTH),
  inputs: "inputs-1",
};
const CODE_MERGED = { pr: 9, sha: MERGE_COMMIT };
const LEASE_HOURS = 3;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const CREATED_AT_MS = Date.parse("2026-10-01T00:00:00.000Z");
const NOW = new Date("2026-10-18T12:00:00.000Z");
const SETTINGS = /** @type {ScheduleSettings} */ ({
  maxJobs: 4,
  stageCaps: { author: 2, review: 2 },
  maxResumes: 2,
  skipLabels: [],
  takeNewWork: true,
  leaseMs: LEASE_HOURS * HOUR_MS,
});

/**
 * An open issue in a snapshot, created in `number` order.
 * @param {number} number
 * @param {Partial<SnapshotIssue>} [over]
 * @returns {SnapshotIssue}
 */
function openIssue(number, over = {}) {
  return {
    number,
    createdAt: new Date(CREATED_AT_MS + number * MINUTE_MS).toISOString(),
    labels: [],
    authorAllowed: true,
    state: null,
    after: [],
    inputs: { current: "inputs-1", gherkin: "inputs-1", asked: null },
    job: null,
    legacyLive: false,
    ...over,
  };
}

/** @param {number} number @returns {IssueState} */
function completion(number) {
  return {
    ...newIssueState(number),
    stage: "done",
    merged: RECEIPT,
    codeMerged: CODE_MERGED,
  };
}

/**
 * The scheduler's decisions for `issues`, by issue, as action, stage and reason.
 * @param {SnapshotIssue[]} issues
 * @param {{ settings?: Partial<ScheduleSettings>, mergeWindow?: number | null }} [run]
 */
function decisionsFor(issues, run = {}) {
  const { decisions } = schedule(
    { issues, mergeWindow: run.mergeWindow ?? null },
    { ...SETTINGS, ...run.settings },
    { now: NOW, gate: null, resumes: {} },
  );
  return Object.fromEntries(
    decisions.map((d) => [d.issue, `${d.action} ${d.stage} ${d.reason}`]),
  );
}

test("an open completion runs a merge job with or without agent:merged and despite a prerequisite", () => {
  for (const issue of [
    openIssue(ISSUE.completion, { state: completion(ISSUE.completion) }),
    openIssue(ISSUE.mergedLabel, {
      state: completion(ISSUE.mergedLabel),
      labels: ["agent:merged"],
    }),
    openIssue(ISSUE.prerequisite, {
      state: completion(ISSUE.prerequisite),
      after: [OPEN_PREREQUISITE],
    }),
  ]) {
    assert.deepEqual(decisionsFor([issue]), {
      [issue.number]: "started merge free",
    });
  }
});

test("plain done, a stopped completion and one with a live job run nothing", () => {
  const liveMerge = {
    stage: /** @type {const} */ ("merge"),
    startedAt: NOW.toISOString(),
    live: true,
    end: null,
  };
  for (const issue of [
    openIssue(ISSUE.plainDone, {
      state: { ...newIssueState(ISSUE.plainDone), stage: "done" },
    }),
    openIssue(ISSUE.stopped, {
      state: completion(ISSUE.stopped),
      labels: ["agent:stopped-ci"],
    }),
    openIssue(ISSUE.liveJob, {
      state: completion(ISSUE.liveJob),
      job: liveMerge,
    }),
  ]) {
    assert.deepEqual(decisionsFor([issue]), {}, String(issue.number));
  }
});

test("an open completion waits for the merge window's holder and the caps", () => {
  const live = {
    stage: /** @type {const} */ ("review"),
    startedAt: NOW.toISOString(),
    live: true,
    end: null,
  };
  const reviewing = openIssue(ISSUE.reviewing, {
    state: { ...newIssueState(ISSUE.reviewing), stage: "review" },
    job: live,
  });
  assert.deepEqual(
    decisionsFor(
      [
        reviewing,
        openIssue(ISSUE.waiting, { state: completion(ISSUE.waiting) }),
      ],
      {
        mergeWindow: ISSUE.reviewing,
      },
    ),
    { [ISSUE.waiting]: `held merge merge-window:#${ISSUE.reviewing}` },
  );
  assert.deepEqual(
    decisionsFor(
      [openIssue(ISSUE.capped, { state: completion(ISSUE.capped) })],
      {
        settings: { stageCaps: { merge: 0 } },
      },
    ),
    { [ISSUE.capped]: "held merge stage-cap" },
  );
  assert.deepEqual(
    decisionsFor(
      [
        reviewing,
        openIssue(ISSUE.overGlobalCap, {
          state: completion(ISSUE.overGlobalCap),
        }),
      ],
      {
        settings: { maxJobs: 1 },
      },
    ),
    { [ISSUE.overGlobalCap]: "held merge global-cap" },
  );
});
