// What every task's matching and prerequisites read from a task view: the
// current revision binding of a task, the latest run of a binding, and
// whether a task passed for exactly a revision and target. Pure.

import type {
  Binding,
  Readiness,
  Revision,
  RevisionBinding,
  TargetState,
  TaskId,
  TaskResult,
  TaskView,
} from "../domain.ts";
import { isRevisionBinding, sameBinding } from "../domain.ts";

type RevisionTask = RevisionBinding["task"];

function sameRevision(a: Revision, b: Revision): boolean {
  return a.code === b.code && a.inputs === b.inputs && a.policy === b.policy;
}

function sameTarget(a: TargetState, b: TargetState): boolean {
  return a.branch === b.branch && a.commit === b.commit;
}

// `task`'s binding of the view's current revision R and target T, or null
// before the item has code.
function currentBinding(
  view: TaskView,
  task: RevisionTask,
): RevisionBinding | null {
  if (view.revision === null) {
    return null;
  }
  return {
    workItem: view.workItem,
    task,
    target: view.target,
    revision: view.revision,
  };
}

// The latest run of `binding` in the view: its verdict, or unknown while
// it's unsettled.
function latestRun(view: TaskView, binding: Binding): TaskResult | undefined {
  return view.results
    .filter((result) => sameBinding(result.binding, binding))
    .at(-1);
}

// The code a passed result attests: what a writer task produced, else the
// code it was bound to.
function attestedCode(result: TaskResult): string | null {
  if (result.receipt.produced !== undefined) {
    return result.receipt.produced.code;
  }
  if (isRevisionBinding(result.binding)) {
    return result.binding.revision.code;
  }
  return null;
}

// The passed result of `task` attesting exactly revision R on target T. A
// writer that produced code attests the code it produced, under the inputs
// and policy it was bound to.
function passedFor(
  view: TaskView,
  task: RevisionTask,
  revision: Revision,
  target: TargetState,
): TaskResult | undefined {
  return view.results.find(
    (result) =>
      result.verdict === "passed" &&
      result.binding.task === task &&
      isRevisionBinding(result.binding) &&
      sameRevision(
        { ...result.binding.revision, code: attestedCode(result) ?? "" },
        revision,
      ) &&
      sameTarget(result.binding.target, target),
  );
}

// Whether Implement passed for the view's current trusted requirements.
function implemented(view: TaskView): boolean {
  return view.results.some(
    (result) =>
      result.verdict === "passed" &&
      result.binding.task === "implement" &&
      "requirements" in result.binding &&
      result.binding.requirements === view.requirements,
  );
}

// The readiness of `binding` from its latest run alone: a missing binding
// is ready; a passed one never runs again; a refused, failed or uncertain
// one holds, since none is retried automatically. `recovers` names whether
// the task has read-only recovery for its own unsettled run.
function runReadiness(
  view: TaskView,
  binding: Binding,
  recovers: boolean,
): Readiness {
  const latest = latestRun(view, binding);
  if (latest === undefined) {
    return { state: "ready", binding };
  }
  if (latest.verdict === "passed") {
    return { state: "waiting", reason: `${binding.task} passed this binding` };
  }
  if (latest.verdict === "unknown" && recovers) {
    return {
      state: "recover",
      binding,
      reason: `${binding.task} run ${latest.run.id} is unsettled; reconcile it by reading`,
    };
  }
  if (latest.verdict === "unknown") {
    return {
      state: "held",
      reason: `${binding.task} run ${latest.run.id} is unsettled and has no read-only reconciliation; reconcile it explicitly`,
    };
  }
  return {
    state: "held",
    reason: `${binding.task} run ${latest.run.id} ${latest.verdict}; it is never retried automatically`,
  };
}

// Whether any run of `task` for the item is unsettled.
function unsettledRun(view: TaskView, task: TaskId): TaskResult | undefined {
  return view.results.find(
    (result) => result.binding.task === task && result.verdict === "unknown",
  );
}

// How many of the item's Fix runs Verify's request-changes caused: each Fix
// attempt, whatever its binding or verdict, whose cause is a refused Verify
// result of the item. A person's review or Land's conflict causes rounds
// that don't count (`review-loop-limit`); the domain's VERIFY_FIX_ROUNDS
// bounds this count.
function verifyFixRounds(view: TaskView): number {
  const refusedVerify = new Set(
    view.results
      .filter(
        (result) =>
          result.binding.task === "verify" && result.verdict === "refused",
      )
      .map((result) => `result:${String(result.recordId)}`),
  );
  return view.results.filter(
    (result) =>
      result.binding.task === "fix" && refusedVerify.has(result.cause.signal),
  ).length;
}

function waiting(reason: string): Readiness {
  return { state: "waiting", reason };
}

function held(reason: string): Readiness {
  return { state: "held", reason };
}

export type { RevisionTask };
export {
  currentBinding,
  held,
  implemented,
  latestRun,
  passedFor,
  runReadiness,
  sameRevision,
  sameTarget,
  unsettledRun,
  verifyFixRounds,
  waiting,
};
