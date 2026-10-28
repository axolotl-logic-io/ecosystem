// How the tasks a start label requests for the head of the issue's linked
// PR, Verify, Fix and Land, read their start: only a start of the task
// itself, naming the head that is current now, requests work. A result or a
// review never does. A new start retries a run of that head that failed,
// within the binding's attempt budget, because a person asked for that head
// again; a passed or refused run stands. Pure.

import type {
  HeadStartTask,
  QualifiedSignal,
  Readiness,
  RevisionBinding,
  TaskView,
} from "../domain.ts";
import { sameBinding } from "../domain.ts";
import {
  currentBinding,
  held,
  latestRun,
  type RevisionTask,
  runReadiness,
  waiting,
} from "./chain.ts";
import { TASK_ATTEMPTS } from "./records.ts";

const NAMES: Readonly<Record<RevisionTask, string>> = {
  verify: "Verify",
  fix: "Fix",
  land: "Land",
  "refactor-safely": "Safe Refactor",
};

// The current binding a start of `task` requests, or the readiness that
// answers `signal` instead: null for any signal that isn't such a start.
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
  if (signal.head !== binding.revision.code) {
    return {
      readiness: waiting(
        `start ${signal.id} names head ${signal.head}, which is no longer the PR's head; a new start is needed`,
      ),
    };
  }
  return { binding };
}

// The readiness a person's start gives `binding`: a new attempt after a run
// that failed, within the binding's attempt budget; otherwise the binding's
// own readiness.
function headStartReadiness(
  signal: QualifiedSignal,
  view: TaskView,
  binding: RevisionBinding,
): Readiness {
  const latest = latestRun(view, binding);
  if (latest?.verdict !== "failed" || latest.cause.signal === signal.id) {
    return runReadiness(view, binding, true);
  }
  const runs = new Set(
    view.results
      .filter((result) => sameBinding(result.binding, binding))
      .map((result) => result.run.id),
  );
  if (runs.size >= TASK_ATTEMPTS) {
    return held(
      `${NAMES[binding.task]} ran ${binding.revision.code} ${String(runs.size)} times, its binding's ${String(TASK_ATTEMPTS)} attempts`,
    );
  }
  return { state: "ready", binding };
}

export { headStartReadiness, startedHead };
