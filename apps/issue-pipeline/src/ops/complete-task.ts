// Complete's effect and its read-only reconciliation, on the v2 records:
//
//   complete-task       for this action's own recorded Complete attempt:
//                       its prerequisites again (the item's own passed Land
//                       of exactly this binding, today's trusted inputs, R
//                       on the target), then closes the issue as completed.
//                       An issue read closed passes; anything else is
//                       unknown. It reruns no Integrate or Security check.
//   complete-reconcile  settles an unsettled Complete as its original run
//                       from one read of the issue: closed passed, open
//                       failed (nothing completed). It never closes.

import type { Config } from "../config.ts";
import type { TargetState } from "../domain.ts";
import { gh, issueState } from "../github.ts";
import { MODULES } from "../tasks/modules.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openReconciliation, openRun, settled } from "./task-run.ts";

function landedCode(run: OpenRun): string {
  if ("revision" in run.binding) {
    return run.binding.revision.code;
  }
  return "";
}

function closed(run: OpenRun): EffectOutcome {
  const state = issueState(run.cfg, run.number);
  if (state === "closed") {
    return {
      verdict: "passed",
      reason: `completed #${run.number}: ${landedCode(run)} is on ${run.cfg.baseBranch}`,
    };
  }
  return {
    verdict: "unknown",
    reason: `#${run.number} reads ${String(state)} after the close`,
  };
}

function provenance(run: OpenRun): {
  land: number | null;
  preTarget: TargetState;
} {
  const land = run.evidence.view.results.find(
    (result) =>
      result.binding.task === "land" &&
      result.verdict === "passed" &&
      result.receipt.produced?.code === landedCode(run),
  );
  return { land: land?.recordId ?? null, preTarget: run.binding.target };
}

function closeIssue(cfg: Config, run: OpenRun): void {
  if (issueState(cfg, run.number) !== "open") {
    return;
  }
  gh(cfg, "landing", [
    "issue",
    "close",
    String(run.number),
    "-R",
    cfg.repo,
    "--reason",
    "completed",
    "--comment",
    `Landed ${landedCode(run)} on ${cfg.baseBranch} (over ${run.binding.target.commit}).`,
  ]);
}

function completeTask(cfg: Config, request: unknown): EffectOutcome {
  const run = openRun(cfg, request, "complete", "complete-task");
  const unmet = MODULES.complete.prerequisite(cfg, run.evidence, run.binding);
  if (unmet !== null) {
    return settled(run, {
      verdict: "failed",
      reason: `nothing completed: ${unmet}`,
    });
  }
  closeIssue(cfg, run);
  return settled(run, closed(run), provenance(run));
}

function completeReconcile(cfg: Config, request: unknown): EffectOutcome {
  const run = openReconciliation(
    cfg,
    request,
    "complete",
    "complete-reconcile",
  );
  let outcome = closed(run);
  if (issueState(cfg, run.number) === "open") {
    outcome = {
      verdict: "failed",
      reason: `reconciled: #${run.number} is still open; nothing completed`,
    };
  }
  return settled(run, outcome, {
    ...provenance(run),
    reconciledBy: run.reconciler,
  });
}

export { completeReconcile, completeTask };
