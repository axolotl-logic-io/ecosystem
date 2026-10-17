// @ts-check
// Recorded queue snapshots of stacked issues for the orchestrator's scheduler
// (#290): a dependent that waits on its prerequisite, or is stacked on it,
// and the prerequisite's facts as the snapshot records them.

import { issue, snapshotOf } from "./orchestrator-fixtures.mjs";

/** @import { Prereq, Snapshot, SnapshotIssue } from "../src/orchestrator/queue.ts" */
/** @import { IssueFields } from "./orchestrator-fixtures.mjs" */
/** @typedef {Prereq & { status: "open" }} OpenPrereq */

// The prerequisite, its dependent, and the head of the prerequisite's branch
// the dependent was put on, and a later one.
const PREREQ = 100;
const DEPENDENT = 101;
const OTHER = 102;
const STACKED_HEAD = "aaaaaaaaaaaaaaaa";
const MOVED_HEAD = "bbbbbbbbbbbbbbbb";
const STACKED_ON = { issue: PREREQ, headSha: STACKED_HEAD };
// A live job keeps a decision for the prerequisite out of the way.
const PREREQ_LIVE = { live: true, stage: "review" };

// The open prerequisite's facts: at checks with no open findings, on the
// head the dependent was put on, not stacked, stopped or behind, then
// `fields`.
/** @param {Partial<OpenPrereq>} [fields] @returns {OpenPrereq} */
function openPrereq(fields = {}) {
  return {
    number: PREREQ,
    status: "open",
    stage: "checks",
    openFindings: 0,
    headSha: STACKED_HEAD,
    stacked: false,
    stopped: false,
    behind: false,
    ...fields,
  };
}

// The prerequisite's own row, its job live unless `fields` say otherwise.
/** @param {IssueFields} [fields] @returns {SnapshotIssue} */
function prereqRow(fields = {}) {
  return issue({
    number: PREREQ,
    stage: "checks",
    job: PREREQ_LIVE,
    ...fields,
  });
}

// A dependent that isn't stacked and waits on its after mark, at triage
// unless `fields` say otherwise, alongside its open prerequisite `prereq`.
/** @param {OpenPrereq} prereq @param {Partial<SnapshotIssue>} [fields] @returns {Snapshot} */
function waitingOn(prereq, fields = {}) {
  return snapshotOf([
    prereqRow({ stage: prereq.stage }),
    issue({
      number: DEPENDENT,
      verdict: { kind: "waiting-on-after" },
      after: [PREREQ],
      prereq,
      ...fields,
    }),
  ]);
}

// A dependent stacked on the prerequisite's STACKED_HEAD, at `stage`, whose
// prerequisite is `prereq`; with `others` beside them.
/** @param {string} stage @param {Prereq} prereq @param {SnapshotIssue[]} [others] @returns {Snapshot} */
function stackedAt(stage, prereq, others = []) {
  const dependent = issue({
    number: DEPENDENT,
    stage,
    pr: 60,
    stackedOn: STACKED_ON,
    prereq,
  });
  /** @type {SnapshotIssue[]} */
  const rows = [];
  if (prereq.status === "open") {
    rows.push(prereqRow({ stage: prereq.stage }));
    dependent.verdict = { kind: "waiting-on-after" };
    dependent.after = [PREREQ];
  }
  return snapshotOf([...rows, dependent, ...others]);
}

// Another issue ready to merge, with its own PR.
const OTHER_AT_MERGE = issue({ number: OTHER, stage: "merge", pr: 70 });

// The prerequisite at fix and older, its branch changing the dependent's
// stub, which the dependent's branch, stacked on it at `stage`, changes too:
// neither has a live job.
/** @param {string} stage @returns {Snapshot} */
function overlapping(stage) {
  return snapshotOf([
    prereqRow({ stage: "fix", job: null, changed: ["src/a.ts"] }),
    issue({
      number: DEPENDENT,
      verdict: { kind: "waiting-on-after" },
      stage,
      stubs: ["src/a.ts"],
      changed: ["src/a.ts"],
      after: [PREREQ],
      stackedOn: STACKED_ON,
      prereq: openPrereq({ stage: "fix" }),
    }),
  ]);
}

// The dependent, older than its prerequisite and past implement, changes the
// stub of the prerequisite at checks.
const OLDER_DEPENDENT = 99;
const OLDER_DEPENDENT_AT_REVIEW = snapshotOf([
  prereqRow({
    stage: "checks",
    job: null,
    stubs: ["src/a.ts"],
    changed: ["src/a.ts"],
  }),
  issue({
    number: OLDER_DEPENDENT,
    verdict: { kind: "waiting-on-after" },
    stage: "review",
    changed: ["src/a.ts"],
    after: [PREREQ],
    stackedOn: STACKED_ON,
    prereq: openPrereq(),
    job: { live: true, stage: "review" },
  }),
]);

export {
  DEPENDENT,
  MOVED_HEAD,
  OLDER_DEPENDENT,
  OLDER_DEPENDENT_AT_REVIEW,
  OTHER,
  OTHER_AT_MERGE,
  openPrereq,
  overlapping,
  PREREQ,
  stackedAt,
  waitingOn,
};
