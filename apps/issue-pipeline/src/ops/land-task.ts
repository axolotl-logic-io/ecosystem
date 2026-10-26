// Land's effect and its read-only reconciliation, on the v2 records:
//
//   land-task       for this action's own recorded Land attempt, under the
//                   integration turn it took first: every prerequisite again
//                   (the repository's Land grant, Verify passing exactly R
//                   on T, R a strict descendant of T, required CI clearing
//                   R), then one
//                   guarded fast-forward of T to R (land-branch.ts). Only the target read at exactly R
//                   passes; the target unchanged after a refused push fails;
//                   anything else stays unknown, keeping the turn.
//   land-reconcile  settles an unsettled Land as its original run from one
//                   read of the target: at R passed, still at T failed,
//                   anything else held. It never pushes.
//
// A passed Land's receipt keeps the pre-Land target, the revision's policy
// and the action's authorization digest as its provenance.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { TargetState } from "../domain.ts";
import { DIGEST } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import { MODULES } from "../tasks/modules.ts";
import { assertLandTurn, releaseSettledTurn } from "../tasks/turn.ts";
import { exactRemote } from "../tasks/view.ts";
import { landBranch } from "./land-branch.ts";
import type { TaskOpSpec } from "./task-guard.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openReconciliation, openRun, settled } from "./task-run.ts";

const AUTHORIZATION = z.looseObject({
  buddy: z.looseObject({ authorizationDigest: DIGEST }),
});

function revisionOf(run: OpenRun): { code: string; target: string } {
  const { binding } = run;
  if (!("revision" in binding)) {
    throw new OpsError("a Land binding binds a revision");
  }
  return { code: binding.revision.code, target: binding.target.commit };
}

function targetNow(run: OpenRun): string | null {
  const { cfg, evidence } = run;
  return exactRemote(cfg, evidence.clone, `refs/heads/${cfg.baseBranch}`);
}

function provenance(
  run: OpenRun,
  authorization: string,
): { preTarget: TargetState; policy: string; authorization: string } {
  const { binding } = run;
  if (!("revision" in binding)) {
    throw new OpsError("a Land binding binds a revision");
  }
  return {
    preTarget: binding.target,
    policy: binding.revision.policy,
    authorization,
  };
}

function landed(run: OpenRun, pushed: boolean): EffectOutcome {
  const { code, target } = revisionOf(run);
  const now = targetNow(run);
  if (now === code) {
    return {
      verdict: "passed",
      reason: `landed ${code} on ${run.cfg.baseBranch} over ${target}`,
      produced: code,
    };
  }
  if (now === target && !pushed) {
    return {
      verdict: "failed",
      reason: `the fast-forward was refused; ${run.cfg.baseBranch} is still at ${target}`,
    };
  }
  return {
    verdict: "unknown",
    reason: `${run.cfg.baseBranch} is at ${String(now)}; the Land is uncertain and keeps its turn`,
  };
}

function landTask(cfg: Config, request: unknown): EffectOutcome {
  const run = openRun(cfg, request, "land", "land-task");
  const { authorizationDigest } = AUTHORIZATION.parse(request).buddy;
  assertLandTurn(cfg, run.number);
  const unmet = MODULES.land.prerequisite(cfg, run.evidence, run.binding);
  let outcome: EffectOutcome;
  if (unmet === null) {
    const { code, target } = revisionOf(run);
    const pushed = landBranch(cfg, run.evidence.clone, target, code);
    outcome = landed(run, pushed);
  } else {
    outcome = { verdict: "failed", reason: `nothing landed: ${unmet}` };
  }
  settled(run, outcome, provenance(run, authorizationDigest));
  releaseSettledTurn(cfg, run.number);
  return outcome;
}

function landReconcile(cfg: Config, request: unknown): EffectOutcome {
  const run = openReconciliation(cfg, request, "land", "land-reconcile");
  const outcome = landed(run, false);
  settled(run, outcome, {
    reconciledBy: run.reconciler,
    preTarget: run.binding.target,
  });
  releaseSettledTurn(cfg, run.number);
  return outcome;
}

// Land's ops, which ops/task-ops.ts serves.
const LAND_OPS: readonly TaskOpSpec[] = [
  { name: "land-task", kind: "substantive", op: landTask },
  { name: "land-reconcile", kind: "finalization", op: landReconcile },
];

export { LAND_OPS };
