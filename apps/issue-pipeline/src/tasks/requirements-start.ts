// How the tasks a start label requests for the issue's trusted requirements,
// Author and Implement, read their start: only a start of the task itself,
// for the requirements current now, is ready; and any attempt of those
// requirements prevents another, whatever the target or a later start
// (docs/reference/stops-and-labels.md). Implement has one exception: a run
// lost before it settled. Its start then recovers it by reading alone,
// even if the requirements changed since. While the requirements are still
// current, the interrupted result that recovery records causes one
// continuation from the branch. The start is never spent twice. Pure.

import type {
  ActionCause,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskResult,
  TaskView,
} from "../domain.ts";
import { INTERRUPTED_EVIDENCE } from "../domain.ts";
import { held, sameTarget, waiting } from "./chain.ts";
import { TASK_ATTEMPTS } from "./records.ts";
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

// The interrupted Implement result a continuation may follow: the latest
// Implement run of the view's requirements, failed by its read-only
// recovery, with attempts left for these requirements. Being the latest
// run, nothing has followed it yet.
function continuable(view: TaskView): TaskResult | undefined {
  const runs = attemptsOf(view.results, "implement", view.requirements);
  const latest = runs.at(-1);
  if (latest?.verdict !== "failed" || runs.length >= TASK_ATTEMPTS) {
    return undefined;
  }
  const interrupted = INTERRUPTED_EVIDENCE.safeParse(latest.receipt.evidence);
  if (!(interrupted.success && interrupted.data.interrupted.continues)) {
    return undefined;
  }
  return latest;
}

// The binding of `task` for the view's current requirements and target.
function currentRequirements(view: TaskView, task: RequirementsTask): Binding {
  return {
    workItem: view.workItem,
    task,
    target: view.target,
    requirements: view.requirements,
  };
}

// Implement's readiness for a result signal: ready to continue only for
// the interrupted result that is continuable now.
function continuationReadiness(
  signal: QualifiedSignal,
  view: TaskView,
): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  if (signal.kind !== "result" || signal.binding.task !== "implement") {
    return null;
  }
  const followed = continuable(view);
  if (followed === undefined || followed.recordId !== signal.recordId) {
    return null;
  }
  return { state: "ready", binding: currentRequirements(view, "implement") };
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
  // A lost run is settled whatever the requirements are now; only a
  // continuation needs them current.
  const own = attemptsOf(view.results, task, signal.requirements).at(-1);
  if (task === "implement" && own?.verdict === "unknown") {
    return {
      state: "recover",
      binding: own.binding,
      reason: `Implement run ${own.run.id} is unsettled; settle it from GitHub by reading`,
    };
  }
  if (signal.requirements !== view.requirements) {
    return waiting(
      `start ${signal.id} binds requirements that are no longer current; a new start is needed`,
    );
  }
  const latest = attemptsOf(view.results, task, view.requirements).at(-1);
  if (latest === undefined) {
    return { state: "ready", binding: currentRequirements(view, task) };
  }
  if (latest.verdict === "passed") {
    return waiting(`${NAMES[task]} passed these requirements`);
  }
  if (task === "implement" && continuable(view) !== undefined) {
    return waiting(
      `Implement run ${latest.run.id} was interrupted; its result continues it`,
    );
  }
  return held(
    `${NAMES[task]} run ${latest.run.id} of these requirements is ${latest.verdict}; a start never retries it`,
  );
}

// Why a new attempt of `task` for `binding` may not be recorded on `view`,
// or null. Only a continuation of a continuable interrupted Implement run,
// caused by that run's result, may follow an attempt of the same
// requirements.
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
  if (attemptsOf(view.results, task, binding.requirements).length === 0) {
    return null;
  }
  let followed: TaskResult | undefined;
  if (task === "implement") {
    followed = continuable(view);
  }
  if (
    followed !== undefined &&
    cause?.recordId === followed.recordId &&
    cause.signal === `result:${String(followed.recordId)}`
  ) {
    return null;
  }
  return `${NAMES[task]} was already attempted for these requirements`;
}

export { continuationReadiness, startReadiness, startUnmet };
