// @ts-check
// Recorded queue snapshots for the orchestrator's scheduler tests: open
// issues with their labels, saved states, trusted-inputs revisions and jobs,
// built from small facts so each test names only what it is about.
import { newIssueState } from "../src/state.ts";

/** @import { IssueJob, ScheduleSettings, Snapshot, SnapshotIssue } from "../src/orchestrator/queue.ts" */
/** @import { IssueState } from "../src/state.ts" */
/** @import { Stage } from "../src/stages.ts" */

const NOW = new Date("2026-10-15T10:00:00.000Z");
const MINUTE_MS = 60_000;
// Issue n was opened ISSUE_SPAN - n minutes before the tick.
const ISSUE_SPAN = 1000;
// The current trusted-inputs revision of every fixture issue, unless changed.
const INPUTS = "inputs-1";
const LEASE_HOURS = 3;
const HOUR_MS = 60 * MINUTE_MS;
// How long before the tick a fixture job started.
const JOB_AGE_MINUTES = 30;
const JOB_AGE_MS = JOB_AGE_MINUTES * MINUTE_MS;

/** @type {ScheduleSettings} */
const SETTINGS = {
  maxJobs: 4,
  stageCaps: { author: 2, review: 2 },
  maxResumes: 2,
  skipLabels: ["wontfix"],
  takeNewWork: true,
  leaseMs: LEASE_HOURS * HOUR_MS,
};

/**
 * One issue's facts: its number, its saved stage (none: no saved state),
 * labels, PR, the after mark's open issues, its inputs revisions, its job,
 * and any other state fields.
 * @typedef {{ number: number, stage?: IssueState["stage"], labels?: string[], pr?: number, after?: number[], current?: string, gherkin?: string | null, asked?: string | null, job?: IssueJob | null, legacyLive?: boolean, authorAllowed?: boolean, state?: Partial<IssueState> }} Facts
 */

/** @param {Facts} facts @returns {SnapshotIssue} */
function issueOf(facts) {
  const { number, stage } = facts;
  /** @type {IssueState | null} */
  let state = null;
  if (stage !== undefined) {
    state = {
      ...newIssueState(number),
      stage,
      pr: facts.pr ?? null,
      ...facts.state,
    };
  }
  const current = facts.current ?? INPUTS;
  // Past the author, an issue's Gherkin was written from its inputs.
  let { gherkin } = facts;
  if (gherkin === undefined) {
    gherkin = null;
    if (stage !== undefined && stage !== "author") {
      gherkin = current;
    }
  }
  return {
    number,
    createdAt: new Date(
      NOW.getTime() - (ISSUE_SPAN - number) * MINUTE_MS,
    ).toISOString(),
    labels: facts.labels ?? [],
    authorAllowed: facts.authorAllowed ?? true,
    state,
    after: facts.after ?? [],
    inputs: { current, gherkin, asked: facts.asked ?? null },
    job: facts.job ?? null,
    legacyLive: facts.legacyLive ?? false,
  };
}

/** @param {readonly Facts[]} issues @param {number | null} [mergeWindow] @returns {Snapshot} */
function snapshotOf(issues, mergeWindow = null) {
  return { issues: issues.map(issueOf), mergeWindow };
}

// A job at `stage`: live, or ended as `end` says (null: died with no outcome).
/** @param {Stage} stage @param {IssueJob["end"] | "live"} end @returns {IssueJob} */
function jobAt(stage, end) {
  const startedAt = new Date(NOW.getTime() - JOB_AGE_MS).toISOString();
  if (end === "live") {
    return { stage, startedAt, live: true, end: null };
  }
  return { stage, startedAt, live: false, end };
}

/** @param {string} at @returns {IssueJob["end"]} */
function failedAt(at) {
  return { kind: "failed", at };
}

export { failedAt, HOUR_MS, INPUTS, jobAt, NOW, SETTINGS, snapshotOf };
