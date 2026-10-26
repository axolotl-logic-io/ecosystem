// Land: the Gatekeeper's merge of the item's PR at the exact head it
// checked (docs/decisions/pr-review.md `land-merges-the-pr`). It binds the
// current revision R, the PR's head, on target T, and needs all of these on
// R: an approval from the landing account (a passed Verify of R) or from a
// qualified person, no request for changes from either, a PR GitHub reports
// mergeable whose head contains T, green required CI, and the trusted
// repository grant (`permissions.land`). An approved PR that conflicts with
// T, or doesn't contain it, goes to Fix instead: Land marks it a draft and
// records why. It takes the target's integration turn before its attempt
// is recorded and keeps it while the run is unsettled. A pass is never
// permission: every check is made again in the ops child
// (ops/land-task.ts). An unsettled run is reconciled read-only, and never
// merged or closed again.

import type { Config } from "../config.ts";
import type {
  ActionContext,
  ActionEnd,
  Binding,
  QualifiedSignal,
  Readiness,
  Revision,
  TaskResult,
  TaskView,
} from "../domain.ts";
import { isRevisionBinding } from "../domain.ts";
import { unapproved } from "../ops/land-approval.ts";
import { historicalPrFor } from "../ops/prs.ts";
import { requiredCiUnmet } from "../ops/required-ci.ts";
import { pullRequest } from "../revision.ts";
import {
  currentBinding,
  runReadiness,
  sameRevision,
  unsettledRun,
  waiting,
} from "./chain.ts";
import { effectEnd, recoverEnd } from "./effect.ts";
import { messageOf } from "./message.ts";
import type { TaskModule } from "./module.ts";
import { notCurrent } from "./module.ts";
import { landGranted } from "./permissions.ts";
import { sensed } from "./sensing.ts";
import { acquireLandTurn } from "./turn.ts";
import type { TaskEvidence } from "./view.ts";

// What a fresh check of a Land binding found: a reason it may not run, an
// approved PR that conflicts with its base, or one ready to merge.
type LandCheck =
  | { state: "unmet"; reason: string }
  | {
      state: "conflict" | "mergeable";
      pr: number;
      head: string;
      reason: string;
    };

// The latest determined Verify result of exactly revision R, whatever the
// target it was checked on: a review binds the head, not the base.
function verifyOn(view: TaskView, revision: Revision): TaskResult | undefined {
  return view.results
    .filter(
      (result) =>
        result.binding.task === "verify" &&
        isRevisionBinding(result.binding) &&
        sameRevision(result.binding.revision, revision) &&
        (result.verdict === "passed" || result.verdict === "refused"),
    )
    .at(-1);
}

// Land wakes on the approval itself: a passed Verify's result of R, or a
// person's approving review of R. Any signal of the item lets its own
// unsettled run recover.
function match(signal: QualifiedSignal, view: TaskView): Readiness | null {
  const shared = sensed(signal, view, signal.kind);
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
  if (binding === null) {
    return waiting("the item has no PR head to land");
  }
  const { code } = binding.revision;
  const verify = verifyOn(view, binding.revision);
  if (verify?.verdict === "refused") {
    return waiting(`Verify requested changes on ${code}`);
  }
  if (signal.kind === "review") {
    if (signal.review.commit !== code) {
      return null;
    }
    if (signal.review.state === "CHANGES_REQUESTED") {
      return waiting(
        `@${signal.provenance.login} requested changes on ${code}`,
      );
    }
    return runReadiness(view, binding, true);
  }
  if (verify === undefined) {
    return waiting(`no approval stands on ${code}`);
  }
  if (signal.kind !== "result" || signal.recordId !== verify.recordId) {
    return null;
  }
  return runReadiness(view, binding, true);
}

function checkPr(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): LandCheck {
  const { view } = evidence;
  if (!isRevisionBinding(binding)) {
    return { state: "unmet", reason: "the binding is not a revision binding" };
  }
  const head = binding.revision.code;
  const { number } = binding.workItem;
  const pr = historicalPrFor(cfg, number);
  if (pr === null) {
    return { state: "unmet", reason: `#${number} has no PR` };
  }
  const current = pullRequest(cfg, number, pr);
  if (current.state !== "OPEN") {
    return { state: "unmet", reason: `PR #${pr} is ${current.state}` };
  }
  if (current.headSha !== head) {
    return {
      state: "unmet",
      reason: `PR #${pr}'s head is ${current.headSha}, not ${head}`,
    };
  }
  if (current.draft) {
    return { state: "unmet", reason: `PR #${pr} is a draft` };
  }
  const refused = unapproved(cfg, pr, head, verifyOn(view, binding.revision));
  if (refused !== null) {
    return { state: "unmet", reason: refused };
  }
  const base = `${view.target.branch} at ${view.target.commit}`;
  if (current.mergeable === "CONFLICTING") {
    return {
      state: "conflict",
      pr,
      head,
      reason: `PR #${pr} at ${head} conflicts with ${base}`,
    };
  }
  if (!view.containsTarget) {
    return {
      state: "conflict",
      pr,
      head,
      reason: `PR #${pr}'s head ${head} does not contain ${base}`,
    };
  }
  if (current.mergeable !== "MERGEABLE") {
    return {
      state: "unmet",
      reason: `GitHub has not yet computed whether PR #${pr} is mergeable`,
    };
  }
  const ci = requiredCiUnmet(cfg, number, head);
  if (ci !== null) {
    return { state: "unmet", reason: ci };
  }
  return {
    state: "mergeable",
    pr,
    head,
    reason: `PR #${pr} is approved and mergeable at ${head}`,
  };
}

// Everything Land needs of `binding`, checked fresh now. A read that fails
// is unmet, never a pass.
function landCheck(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): LandCheck {
  if (!landGranted(cfg)) {
    return {
      state: "unmet",
      reason: "the repository configuration grants no Land permission",
    };
  }
  const stale = notCurrent(evidence, binding);
  if (stale !== null) {
    return { state: "unmet", reason: stale };
  }
  try {
    return checkPr(cfg, evidence, binding);
  } catch (error) {
    return {
      state: "unmet",
      reason: `Land's evidence is unreadable: ${messageOf(error)}`,
    };
  }
}

function prerequisite(
  cfg: Config,
  evidence: TaskEvidence,
  binding: Binding,
): string | null {
  const check = landCheck(cfg, evidence, binding);
  if (check.state === "unmet") {
    return check.reason;
  }
  return null;
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

export type { LandCheck };
export { land, landCheck };
