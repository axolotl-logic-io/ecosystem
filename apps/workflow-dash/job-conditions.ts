// Conditions of historical job records. A legacy job process observation is
// only that: it names no current buddy run or action run and makes no
// capacity claim.
import type { HistoricalJob } from "./job-history.ts";

const stoppedOutcome = /stop|fail|error/u;
type JobProcessObservation =
  | "legacy job process observed"
  | "unknown"
  | "not inspected; ended record"
  | "legacy job process not observed";
type JobCondition =
  | "● LEGACY JOB PROCESS"
  | "◷ HISTORY"
  | "? UNKNOWN"
  | "○ NOT OBSERVED"
  | "✗ STOPPED RECORD"
  | "◷ ENDED RECORD";

function jobProcessObservation(run: HistoricalJob): JobProcessObservation {
  if (run.live === true) {
    return "legacy job process observed";
  }
  if (run.live === null || run.data.outcome === undefined) {
    return "unknown";
  }
  if (run.data.history === true || run.data.outcome !== null) {
    return "not inspected; ended record";
  }
  return "legacy job process not observed";
}

function jobCondition(run: HistoricalJob): JobCondition {
  if (run.live === true) {
    return "● LEGACY JOB PROCESS";
  }
  if (run.data.history === true) {
    return "◷ HISTORY";
  }
  if (run.live === null || run.data.outcome === undefined) {
    return "? UNKNOWN";
  }
  if (run.data.outcome === null) {
    return "○ NOT OBSERVED";
  }
  const outcome = JSON.stringify(run.data.outcome);
  if (stoppedOutcome.test(outcome)) {
    return "✗ STOPPED RECORD";
  }
  return "◷ ENDED RECORD";
}

function legacyJobProcesses(runs: HistoricalJob[]): {
  observed: number;
  unknown: number;
  note: string;
} {
  return {
    observed: runs.filter((run) => run.live === true).length,
    unknown: runs.filter((run) => run.live === null).length,
    note: "Legacy job.mjs process observations only; they name no current buddy run or action run and make no capacity claim.",
  };
}

export { jobCondition, jobProcessObservation, legacyJobProcesses };
