// Implement: the only task a human start requests. It binds the work item's
// current trusted requirements and target, and any Implement attempt of the
// same requirements prevents another, whatever the target or a new start.
// Its action is one Developer session, then the branch push and the PR.

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
import { held, sameTarget, waiting } from "./chain.ts";
import type { TaskModule } from "./module.ts";
import { notWritable } from "./module.ts";
import { sensed } from "./sensing.ts";
import type { TaskEvidence } from "./view.ts";
import { writerAction } from "./writer-session.ts";

function attemptsOf(
  results: readonly TaskResult[],
  requirements: string,
): TaskResult[] {
  return results.filter(
    (result) =>
      result.binding.task === "implement" &&
      "requirements" in result.binding &&
      result.binding.requirements === requirements,
  );
}

function readiness(
  view: TaskView,
  requirements: string,
  binding: Binding,
): Readiness {
  const latest = attemptsOf(view.results, requirements).at(-1);
  if (latest === undefined) {
    return { state: "ready", binding };
  }
  if (latest.verdict === "passed") {
    return waiting("Implement passed these requirements");
  }
  return held(
    `Implement run ${latest.run.id} of these requirements is ${latest.verdict}; a start never retries it`,
  );
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "start");
  if (shared !== undefined) {
    return shared;
  }
  if (signal.kind !== "start") {
    return null;
  }
  if (signal.requirements !== view.requirements) {
    return waiting(
      `start ${signal.id} binds requirements that are no longer current; a new start is needed`,
    );
  }
  return readiness(view, view.requirements, {
    workItem: view.workItem,
    task: "implement",
    target: view.target,
    requirements: view.requirements,
  });
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  const { view } = evidence;
  if (!("requirements" in binding) || binding.task !== "implement") {
    return "the binding is not an Implement binding";
  }
  if (binding.requirements !== view.requirements) {
    return "the binding's requirements are not the current trusted requirements";
  }
  if (!sameTarget(binding.target, view.target)) {
    return "the binding's target is not the current target";
  }
  if (attemptsOf(view.results, binding.requirements).length > 0) {
    return "Implement was already attempted for these requirements";
  }
  return notWritable(cfg, view.workItem.number);
}

const implement: TaskModule = {
  definition: {
    id: "implement",
    role: "developer",
    access: "writer",
    sensors: ["start", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act: (ctx: ActionContext): Promise<ActionEnd> =>
      writerAction(ctx, "development"),
  },
  prerequisite,
  ownsResult: false,
  writesCode: true,
};

export { implement };
