// Harden: the Developer's fresh review and repair of revision R on target T,
// once Implement passed the current requirements and R contains T. Its pass
// attests the code it pushed, so Harden of its own output never repeats;
// Sync's output, new code, needs a fresh Harden.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import {
  currentBinding,
  implemented,
  passedFor,
  runReadiness,
  waiting,
} from "./chain.ts";
import type { TaskModule } from "./module.ts";
import { notCurrent, notWritable } from "./module.ts";
import { sensed } from "./sensing.ts";
import type { TaskEvidence } from "./view.ts";
import { writerAction } from "./writer-session.ts";

// Why Harden of the view's current revision can't start, or null.
function blocked(view: TaskView): string | null {
  if (view.revision === null) {
    return `#${view.workItem.number} has no code yet`;
  }
  if (!implemented(view)) {
    return "Implement has not passed the current requirements";
  }
  if (!view.containsTarget) {
    return "the revision does not contain the target; Sync first";
  }
  if (passedFor(view, "harden", view.revision, view.target) !== undefined) {
    return "Harden passed this revision and target";
  }
  return null;
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  const binding = currentBinding(view, "harden");
  const why = blocked(view);
  if (why !== null || binding === null) {
    return waiting(why ?? "the work item has no code yet");
  }
  return runReadiness(view, binding, false);
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  return (
    notCurrent(evidence, binding) ??
    blocked(evidence.view) ??
    notWritable(cfg, evidence.view.workItem.number)
  );
}

const harden: TaskModule = {
  definition: {
    id: "harden",
    role: "developer",
    access: "writer",
    sensors: ["result", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act: (ctx: ActionContext): Promise<ActionEnd> =>
      writerAction(ctx, "hardening"),
  },
  prerequisite,
  ownsResult: false,
  writesCode: true,
};

export { harden };
