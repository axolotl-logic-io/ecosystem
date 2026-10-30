// Implement runs for current trusted requirements after a fresh start of
// its own task. A new start continues a failed run; the old
// start is spent. Unsettled work is reconciled before a replacement runs.

import type {
  ActionCause,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import { held, sameTarget, unsettledRun, waiting } from "./chain.ts";
import { sensed } from "./sensing.ts";

type RequirementsTask = "implement";
const NAMES: Readonly<Record<RequirementsTask, string>> = {
  implement: "Implement",
};

function currentRequirements(view: TaskView, task: RequirementsTask): Binding {
  return {
    workItem: view.workItem,
    task,
    target: view.target,
    requirements: view.requirements,
  };
}

function startReadiness(
  signal: QualifiedSignal,
  view: TaskView,
  task: RequirementsTask,
): Readiness | null {
  const shared = sensed(signal, view, "start");
  if (shared !== undefined) {
    return shared;
  }
  const open = unsettledRun(view, task);
  if (open !== undefined) {
    return {
      state: "recover",
      binding: open.binding,
      reason: `${NAMES[task]} run ${open.run.id} is unsettled; settle it by reading`,
    };
  }
  if (signal.kind !== "start" || signal.task !== task) {
    return null;
  }
  if (signal.requirements !== view.requirements) {
    return waiting(
      `start ${signal.id} binds requirements that are no longer current; a new start is needed`,
    );
  }
  const binding = currentRequirements(view, task);
  const unmet = startUnmet(view, binding, task, {
    signal: signal.id,
    recordId: signal.recordId,
  });
  if (unmet !== null) {
    return held(unmet);
  }
  return { state: "ready", binding };
}

/** A failed run may be followed only by a fresh human start of this task. */
function startUnmet(
  view: TaskView,
  binding: Binding,
  task: RequirementsTask,
  cause?: ActionCause,
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
  const latest = view.results
    .filter(
      (result) =>
        result.binding.task === task &&
        "requirements" in result.binding &&
        result.binding.requirements === binding.requirements,
    )
    .at(-1);
  if (latest === undefined) {
    return null;
  }
  if (
    latest.verdict === "failed" &&
    cause?.signal.startsWith("github-label:") === true &&
    cause.signal !== latest.cause.signal
  ) {
    return null;
  }
  return `${NAMES[task]} run ${latest.run.id} of these requirements is ${latest.verdict}; a failed run needs a fresh start`;
}

export { startReadiness, startUnmet };
