// Integrate: the Gatekeeper's read-only check of revision R on exactly
// target T, once R contains T and Harden attests R on T. Its effect op
// (ops/integrate-task.ts) runs the configured checks in a detached checkout
// and records the verdict.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import { currentBinding, passedFor, runReadiness, waiting } from "./chain.ts";
import { effectEnd } from "./effect.ts";
import type { TaskModule } from "./module.ts";
import { notCurrent } from "./module.ts";
import { sensed } from "./sensing.ts";
import type { TaskEvidence } from "./view.ts";

function blocked(view: TaskView): string | null {
  if (view.revision === null) {
    return `#${view.workItem.number} has no code yet`;
  }
  if (!view.containsTarget) {
    return "the revision does not contain the target";
  }
  if (passedFor(view, "harden", view.revision, view.target) === undefined) {
    return "Harden has not passed this revision and target";
  }
  return null;
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  const binding = currentBinding(view, "integrate");
  const why = blocked(view);
  if (why !== null || binding === null) {
    return waiting(why ?? "the work item has no code yet");
  }
  return runReadiness(view, binding, false);
}

function prerequisite(
  _cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  return notCurrent(evidence, binding) ?? blocked(evidence.view);
}

const integrate: TaskModule = {
  definition: {
    id: "integrate",
    role: "gatekeeper",
    access: "reader",
    sensors: ["result", "stop"],
    resources: ["test-slot"],
    match,
    act: (ctx: ActionContext): Promise<ActionEnd> =>
      effectEnd(ctx, "integrate-task"),
  },
  prerequisite,
  ownsResult: true,
  writesCode: false,
};

export { blocked as integrateBlocked, integrate };
