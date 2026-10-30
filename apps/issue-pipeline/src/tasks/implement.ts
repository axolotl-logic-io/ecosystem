// Implement: requested by `start:implement`. It binds the work item's current
// trusted requirements and target, and any Implement attempt of the same
// requirements prevents another, whatever the target or a new start. It
// doesn't wait for the Gherkin task app (gherkin.ts). Its action is the Developer's writing session,
// then a fresh hardening session that tries to break the change, then the
// branch push and the development account's ready PR. Every commit is
// pushed as it is made, so the branch keeps the work if the run is lost. A
// lost run is settled by reading (`implement-reconcile`); a new
// `start:implement` then continues it from the branch.

import type { Config } from "../config.ts";
import type {
  ActionCause,
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  TaskView,
} from "../domain.ts";
import { recoverEnd } from "./effect.ts";
import type { TaskModule } from "./module.ts";
import { notWritable } from "./module.ts";
import { startReadiness, startUnmet } from "./requirements-start.ts";
import type { TaskEvidence } from "./view.ts";
import { implementAction } from "./writer-session.ts";

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  return startReadiness(signal, view, "implement");
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
  cause?: ActionCause,
): string | null {
  const { view } = evidence;
  return (
    startUnmet(view, binding, "implement", cause) ??
    notWritable(cfg, view.workItem.number)
  );
}

const implement: TaskModule = {
  definition: {
    id: "implement",
    role: "developer",
    access: "writer",
    sensors: ["start", "stop"],
    resources: ["model-session", "test-slot"],
    match,
    act: implementAction,
    recover: (ctx: ActionContext): Promise<ActionEnd> =>
      recoverEnd(ctx, "implement-reconcile"),
  },
  prerequisite,
  ownsResult: false,
  writesCode: true,
};

export { implement };
