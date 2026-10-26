// How every task reads a qualified signal before its own matching: a
// signal of another work item is not its business; an accepted stop stops
// it; evidence that holds the item holds it.

import type { QualifiedSignal, Readiness, TaskView } from "../domain.ts";

function sameItem(signal: QualifiedSignal, view: TaskView): boolean {
  return (
    signal.workItem.repo.toLowerCase() === view.workItem.repo.toLowerCase() &&
    signal.workItem.number === view.workItem.number
  );
}

// The readiness every task shares, or undefined when the task's own
// matching decides: null for another item's signal, stopped for a stop,
// held for held evidence.
function sensed(
  signal: QualifiedSignal,
  view: TaskView,
  kind: QualifiedSignal["kind"],
): Readiness | null | undefined {
  if (!sameItem(signal, view)) {
    return null;
  }
  if (signal.kind === "stop") {
    return { state: "stopped", reason: `stop ${signal.id} was accepted` };
  }
  if (signal.kind !== kind) {
    return null;
  }
  if (view.hold !== null) {
    return { state: "held", reason: view.hold };
  }
  return undefined;
}

export { sameItem, sensed };
