// @ts-check
// The scheduler's completion reconciliation (src/orchestrator/schedule.ts,
// issue-plan.ts; `completion-reconciliation`): an open issue saved done with
// what merged runs a merge job, with or without agent:merged and despite an
// open prerequisite. That job never merges, so it bypasses the merge window
// and the merge queue and never opens, holds or blocks them for a code merge,
// while the caps still count it; a plain done, a stopped completion and one
// with a live job run nothing. The pipeline root is a temporary one before
// src/ loads.
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
  codeMerge: 65,
  laterCodeMerge: 66,
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

/** @param {number} number @returns {IssueState} */
function readyToMerge(number) {
  return { ...newIssueState(number), stage: "merge", pr: number };
}

/**
 * A live job at `stage`.
 * @param {"review" | "merge"} stage
 */
function liveJob(stage) {
  return { stage, startedAt: NOW.toISOString(), live: true, end: null };
}

/**
 * @typedef {object} Run
 * @property {Partial<ScheduleSettings>} [settings]
 * @property {number | null} [mergeWindow]
 */

/** @param {SnapshotIssue[]} issues @param {Run} run */
function scheduled(issues, run) {
  return schedule(
    { issues, mergeWindow: run.mergeWindow ?? null },
    { ...SETTINGS, ...run.settings },
    { now: NOW, gate: null, resumes: {} },
  );
}

/**
 * The scheduler's decisions for `issues`, by issue, as action, stage and
 * reason, a started merge's queue after it, and the window it leaves.
 * @param {SnapshotIssue[]} issues
 * @param {Run} [run]
 */
function decisionsFor(issues, run = {}) {
  const { decisions, memory } = scheduled(issues, run);
  /** @type {Record<string, string>} */
  const byIssue = {};
  for (const d of decisions) {
    let line = `${d.action} ${d.stage} ${d.reason}`;
    if (d.action === "started" && d.mergeQueue !== null) {
      line += ` queue:${d.mergeQueue.join(",")}`;
    }
    byIssue[d.issue] = line;
  }
  return { ...byIssue, window: memory.mergeWindow };
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
      window: null,
    });
  }
});

test("several open completions all start at once, with no merge queue", () => {
  const issues = [ISSUE.completion, ISSUE.mergedLabel, ISSUE.waiting].map((n) =>
    openIssue(n, { state: completion(n) }),
  );
  assert.deepEqual(decisionsFor(issues), {
    [ISSUE.completion]: "started merge free",
    [ISSUE.mergedLabel]: "started merge free",
    [ISSUE.waiting]: "started merge free",
    window: null,
  });
});

test("plain done, a stopped completion and one with a live job run nothing", () => {
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
      job: liveJob("merge"),
    }),
  ]) {
    assert.deepEqual(
      decisionsFor([issue]),
      { window: null },
      String(issue.number),
    );
  }
});

test("an open completion bypasses a held merge window but not the caps", () => {
  const reviewing = openIssue(ISSUE.reviewing, {
    state: { ...newIssueState(ISSUE.reviewing), stage: "review" },
    job: liveJob("review"),
  });
  assert.deepEqual(
    decisionsFor(
      [
        reviewing,
        openIssue(ISSUE.waiting, { state: completion(ISSUE.waiting) }),
      ],
      { mergeWindow: ISSUE.reviewing },
    ),
    { [ISSUE.waiting]: "started merge free", window: ISSUE.reviewing },
  );
  assert.deepEqual(
    decisionsFor(
      [openIssue(ISSUE.capped, { state: completion(ISSUE.capped) })],
      {
        settings: { stageCaps: { merge: 0 } },
      },
    ),
    { [ISSUE.capped]: "held merge stage-cap", window: null },
  );
  assert.deepEqual(
    decisionsFor(
      [
        reviewing,
        openIssue(ISSUE.overGlobalCap, {
          state: completion(ISSUE.overGlobalCap),
        }),
      ],
      { settings: { maxJobs: 1 }, mergeWindow: ISSUE.reviewing },
    ),
    { [ISSUE.overGlobalCap]: "held merge global-cap", window: ISSUE.reviewing },
  );
});

test("a completion, starting or live, never opens, holds or joins the window a code merge needs", () => {
  const codeMerge = openIssue(ISSUE.codeMerge, {
    state: readyToMerge(ISSUE.codeMerge),
  });
  const waiting = openIssue(ISSUE.waiting, {
    state: completion(ISSUE.waiting),
  });
  // Ranked first by creation, the completion still leaves the window and the
  // queue to the code merge.
  assert.deepEqual(decisionsFor([waiting, codeMerge]), {
    [ISSUE.waiting]: "started merge free",
    [ISSUE.codeMerge]: `started merge free queue:${ISSUE.codeMerge}`,
    window: ISSUE.codeMerge,
  });
  const liveCompletion = openIssue(ISSUE.liveJob, {
    state: completion(ISSUE.liveJob),
    job: liveJob("merge"),
  });
  assert.deepEqual(decisionsFor([liveCompletion, codeMerge]), {
    [ISSUE.codeMerge]: `started merge free queue:${ISSUE.codeMerge}`,
    window: ISSUE.codeMerge,
  });
  // A window remembered for an issue that is now a completion is given up.
  assert.deepEqual(
    decisionsFor([waiting, codeMerge], { mergeWindow: ISSUE.waiting }),
    {
      [ISSUE.waiting]: "started merge free",
      [ISSUE.codeMerge]: `started merge free queue:${ISSUE.codeMerge}`,
      window: ISSUE.codeMerge,
    },
  );
});

test("code merges keep their window and order beside completions", () => {
  const issues = [
    openIssue(ISSUE.waiting, { state: completion(ISSUE.waiting) }),
    openIssue(ISSUE.codeMerge, { state: readyToMerge(ISSUE.codeMerge) }),
    openIssue(ISSUE.laterCodeMerge, {
      state: readyToMerge(ISSUE.laterCodeMerge),
    }),
  ];
  assert.deepEqual(decisionsFor(issues), {
    [ISSUE.waiting]: "started merge free",
    [ISSUE.codeMerge]: `started merge free queue:${ISSUE.codeMerge},${ISSUE.laterCodeMerge}`,
    [ISSUE.laterCodeMerge]: `held merge merge-window:#${ISSUE.codeMerge}`,
    window: ISSUE.codeMerge,
  });
  const liveCodeMerge = openIssue(ISSUE.codeMerge, {
    state: readyToMerge(ISSUE.codeMerge),
    job: liveJob("merge"),
  });
  assert.deepEqual(
    decisionsFor([
      liveCodeMerge,
      openIssue(ISSUE.laterCodeMerge, {
        state: readyToMerge(ISSUE.laterCodeMerge),
      }),
    ]),
    {
      [ISSUE.laterCodeMerge]: `held merge merge-window:#${ISSUE.codeMerge}`,
      window: ISSUE.codeMerge,
    },
  );
});
