// Complete: closes the work item after its own passed Land. Its binding is
// the Land's: the original revision R, its policy, and the pre-Land target
// T. It checks the current trusted inputs, the Land's own authenticated
// receipt and that the target now contains R; it never reruns Integrate or
// Review Security, and a policy changed after Land neither grants nor
// requires anything. An unsettled run is reconciled read-only.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskResult,
  TaskView,
} from "../domain.ts";
import { isRevisionBinding } from "../domain.ts";
import {
  runReadiness,
  sameRevision,
  sameTarget,
  unsettledRun,
  waiting,
} from "./chain.ts";
import { effectEnd, recoverEnd } from "./effect.ts";
import type { TaskModule } from "./module.ts";
import { sensed } from "./sensing.ts";
import type { TaskEvidence } from "./view.ts";
import { isAncestor } from "./view.ts";

// The item's own passed Land that delivered exactly the code it bound.
function passedLand(view: TaskView): TaskResult | undefined {
  return view.results.find(
    (result) =>
      result.binding.task === "land" &&
      result.verdict === "passed" &&
      isRevisionBinding(result.binding) &&
      result.receipt.produced?.code === result.binding.revision.code,
  );
}

function completionOf(land: TaskResult): Binding | null {
  if (!isRevisionBinding(land.binding)) {
    return null;
  }
  return { ...land.binding, task: "complete" };
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  const open = unsettledRun(view, "complete");
  if (open !== undefined) {
    return runReadiness(view, open.binding, true);
  }
  const land = passedLand(view);
  let binding: Binding | null = null;
  if (land !== undefined) {
    binding = completionOf(land);
  }
  if (binding === null) {
    return waiting("the work item has no passed Land of its own");
  }
  return runReadiness(view, binding, true);
}

// Why `binding` can't complete now, or null: it must be exactly the
// passed Land's binding, under today's trusted inputs, with R on the target.
function prerequisite(
  _cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  const { view, clone } = evidence;
  const land = passedLand(view);
  if (
    land === undefined ||
    !isRevisionBinding(land.binding) ||
    !isRevisionBinding(binding) ||
    binding.task !== "complete" ||
    !sameRevision(land.binding.revision, binding.revision) ||
    !sameTarget(land.binding.target, binding.target)
  ) {
    return `the binding is not #${view.workItem.number}'s own passed Land`;
  }
  if (view.requirements !== `sha256:${binding.revision.inputs}`) {
    return "the trusted inputs changed since the Land";
  }
  if (!isAncestor(clone, binding.revision.code, view.target.commit)) {
    return "the target no longer contains the landed revision";
  }
  return null;
}

const complete: TaskModule = {
  definition: {
    id: "complete",
    role: "gatekeeper",
    access: "lander",
    sensors: ["result", "stop"],
    resources: [],
    match,
    act: (ctx: ActionContext): Promise<ActionEnd> =>
      effectEnd(ctx, "complete-task"),
    recover: (ctx: ActionContext): Promise<ActionEnd> =>
      recoverEnd(ctx, "complete-reconcile"),
  },
  prerequisite,
  ownsResult: true,
  writesCode: false,
};

export { complete, passedLand };
