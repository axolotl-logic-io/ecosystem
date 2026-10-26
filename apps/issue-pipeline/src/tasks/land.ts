// Land: the Gatekeeper's guarded, immutable fast-forward of target T to
// revision R. It needs the trusted repository grant (`permissions.land`),
// Verify passing exactly R on T, required CI clearing exactly R as its PR's
// head (ops/required-ci.ts), and the target's integration turn, which it
// takes before its attempt is recorded and keeps while the run is
// unsettled. A pass is never permission: every check is made again in the
// ops child (ops/land-task.ts). An unsettled run is reconciled read-only
// and never pushed again.
//
// docs/decisions/pr-review.md `land-merges-the-pr` replaces this
// fast-forward with a merge of the PR at its checked head that also closes
// the issue.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  Revision,
  TargetState,
  TaskView,
} from "../domain.ts";
import { requiredCiUnmet } from "../ops/required-ci.ts";
import {
  currentBinding,
  passedFor,
  runReadiness,
  unsettledRun,
  waiting,
} from "./chain.ts";
import { effectEnd, recoverEnd } from "./effect.ts";
import type { TaskModule } from "./module.ts";
import { notCurrent } from "./module.ts";
import { landGranted } from "./permissions.ts";
import { sensed } from "./sensing.ts";
import { acquireLandTurn } from "./turn.ts";
import type { TaskEvidence } from "./view.ts";

const ATTESTING = ["verify"] as const;

// Why R can't land on T from these results, or null.
function unattested(
  view: TaskView,
  revision: Revision,
  target: TargetState,
): string | null {
  for (const task of ATTESTING) {
    if (passedFor(view, task, revision, target) === undefined) {
      return `${task} has not passed this revision and target`;
    }
  }
  return null;
}

function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, "result");
  if (shared !== undefined) {
    return shared;
  }
  const open = unsettledRun(view, "land");
  if (open !== undefined) {
    return runReadiness(view, open.binding, true);
  }
  if (!view.permissions.land) {
    return waiting("the repository configuration grants no Land permission");
  }
  const binding = currentBinding(view, "land");
  if (binding === null || !view.containsTarget) {
    return waiting("the revision does not contain the target");
  }
  const why = unattested(view, binding.revision, binding.target);
  if (why !== null) {
    return waiting(why);
  }
  return runReadiness(view, binding, true);
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  if (!landGranted(cfg)) {
    return "the repository configuration grants no Land permission";
  }
  const stale = notCurrent(evidence, binding);
  if (stale !== null || !("revision" in binding)) {
    return stale ?? "the binding is not a revision binding";
  }
  const { view } = evidence;
  if (!view.containsTarget || binding.revision.code === view.target.commit) {
    return "the revision is not a strict descendant of the target";
  }
  return (
    unattested(view, binding.revision, binding.target) ??
    requiredCiUnmet(cfg, binding.workItem.number, binding.revision.code)
  );
}

const land: TaskModule = {
  definition: {
    id: "land",
    role: "gatekeeper",
    access: "lander",
    sensors: ["result", "review", "stop"],
    resources: ["target-write"],
    match,
    act: (ctx: ActionContext): Promise<ActionEnd> =>
      effectEnd(ctx, "land-task"),
    recover: (ctx: ActionContext): Promise<ActionEnd> =>
      recoverEnd(ctx, "land-reconcile"),
  },
  prerequisite,
  admit: acquireLandTurn,
  ownsResult: true,
  writesCode: false,
};

export { land, unattested };
