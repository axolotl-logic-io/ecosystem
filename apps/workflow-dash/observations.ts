import type { WorkflowRun } from "./workflow-source.ts";

const stoppedOutcome = /stop|fail|error/u;
type ProcessObservation =
  | "process observed; lease not checked"
  | "unknown"
  | "not inspected; ended record"
  | "matching workflow process not observed";
type RunCondition =
  | "● PROCESS OBSERVED"
  | "◷ HISTORY"
  | "? UNKNOWN"
  | "○ NOT OBSERVED"
  | "✗ STOPPED RECORD"
  | "◷ ENDED RECORD";

function processObservation(run: WorkflowRun): ProcessObservation {
  if (run.live === true) {
    return "process observed; lease not checked";
  }
  if (run.live === null || run.data.outcome === undefined) {
    return "unknown";
  }
  if (run.data.history === true || run.data.outcome !== null) {
    return "not inspected; ended record";
  }
  return "matching workflow process not observed";
}

function runCondition(run: WorkflowRun): RunCondition {
  if (run.live === true) {
    return "● PROCESS OBSERVED";
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

function observedCapacity(runs: WorkflowRun[]): {
  observedProcesses: number;
  unknownProcesses: number;
  configuredLimit: null;
  source: string;
} {
  return {
    observedProcesses: runs.filter((run) => run.live === true).length,
    unknownProcesses: runs.filter((run) => run.live === null).length,
    configuredLimit: null,
    source:
      "Process observations only; leases, configured resource caps and releases are not collected.",
  };
}

export { observedCapacity, processObservation, runCondition };
