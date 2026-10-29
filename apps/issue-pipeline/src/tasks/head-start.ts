// How the tasks a start label requests for the issue's linked PR, Verify,
// Fix and Land, read their start: only a start of the task itself requests
// work, and it requests the PR's head as it is when the task runs. A push
// after the start was accepted doesn't make it stale; the head it recorded
// at acceptance is evidence, not a condition. A result or a review never
// requests work. A fresh start retries a failed run without an attempt
// limit; a passed or refused run stands. Pure.

import type {
  HeadStartTask,
  QualifiedSignal,
  Readiness,
  RevisionBinding,
  TaskView,
} from "../domain.ts";
import {
  currentBinding,
  latestRun,
  type RevisionTask,
  runReadiness,
  waiting,
} from "./chain.ts";

const NAMES: Readonly<Record<RevisionTask, string>> = {
  verify: "Verify",
  fix: "Fix",
  land: "Land",
  "refactor-safely": "Safe Refactor",
};

// The current binding a start of `task` requests, whatever head it was
// accepted for, or the readiness that answers `signal` instead: null for
// any signal that isn't such a start.
function startedHead(
  signal: QualifiedSignal,
  view: TaskView,
  task: HeadStartTask,
): { binding: RevisionBinding } | { readiness: Readiness | null } {
  if (signal.kind !== "start" || signal.task !== task) {
    return { readiness: null };
  }
  const binding = currentBinding(view, task);
  if (binding === null) {
    return {
      readiness: waiting(`the item has no PR head for ${NAMES[task]}`),
    };
  }
  return { binding };
}

// A fresh start continues a failed run; otherwise use the binding's readiness.
function headStartReadiness(
  signal: QualifiedSignal,
  view: TaskView,
  binding: RevisionBinding,
): Readiness {
  const latest = latestRun(view, binding);
  if (latest?.verdict !== "failed" || latest.cause.signal === signal.id) {
    return runReadiness(view, binding, true);
  }
  return { state: "ready", binding };
}

export { headStartReadiness, startedHead };
