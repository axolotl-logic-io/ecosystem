// How the tasks a start label requests for the issue's trusted
// requirements, Author and Implement, read their start (`start-labels`):
// only a start of the task itself, for the requirements current now, is
// ready; and any attempt of those requirements prevents another, whatever
// the target or a later start (docs/reference/stops-and-labels.md). Pure.

import type {
  Binding,
  QualifiedSignal,
  Readiness,
  TaskResult,
  TaskView,
} from "../domain.ts";
import { held, sameTarget, waiting } from "./chain.ts";
import { sensed } from "./sensing.ts";

type RequirementsTask = "author" | "implement";

const NAMES: Readonly<Record<RequirementsTask, string>> = {
  author: "Author",
  implement: "Implement",
};

function attemptsOf(
  results: readonly TaskResult[],
  task: RequirementsTask,
  requirements: string,
): TaskResult[] {
  return results.filter(
    (result) =>
      result.binding.task === task &&
      "requirements" in result.binding &&
      result.binding.requirements === requirements,
  );
}

// The readiness of `task` for `signal`: null unless it is a start of
// `task` on this item.
function startReadiness(
  signal: QualifiedSignal,
  view: TaskView,
  task: RequirementsTask,
): Readiness | null {
  const shared = sensed(signal, view, "start");
  if (shared !== undefined) {
    return shared;
  }
  if (signal.kind !== "start" || signal.task !== task) {
    return null;
  }
  if (signal.requirements !== view.requirements) {
    return waiting(
      `start ${signal.id} binds requirements that are no longer current; a new start is needed`,
    );
  }
  const latest = attemptsOf(view.results, task, view.requirements).at(-1);
  if (latest === undefined) {
    return {
      state: "ready",
      binding: {
        workItem: view.workItem,
        task,
        target: view.target,
        requirements: view.requirements,
      },
    };
  }
  if (latest.verdict === "passed") {
    return waiting(`${NAMES[task]} passed these requirements`);
  }
  return held(
    `${NAMES[task]} run ${latest.run.id} of these requirements is ${latest.verdict}; a start never retries it`,
  );
}

// Why a new attempt of `task` for `binding` may not be recorded on `view`,
// or null.
function startUnmet(
  view: TaskView,
  binding: Binding,
  task: RequirementsTask,
): string | null {
  if (!("requirements" in binding) || binding.task !== task) {
    return `the binding is not ${NAMES[task]}'s`;
  }
  if (binding.requirements !== view.requirements) {
    return "the binding's requirements are not the current trusted requirements";
  }
  if (!sameTarget(binding.target, view.target)) {
    return "the binding's target is not the current target";
  }
  if (attemptsOf(view.results, task, binding.requirements).length > 0) {
    return `${NAMES[task]} was already attempted for these requirements`;
  }
  return null;
}

export { startReadiness, startUnmet };
