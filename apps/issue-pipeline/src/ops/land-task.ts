// Land's effect and its read-only reconciliation, on the v2 records:
//
//   land-task       for this action's own recorded Land attempt, under the
//                   integration turn it took first: every check again
//                   (tasks/land.ts landCheck), then either one merge of the
//                   PR with a merge commit pinned to the head it checked
//                   (`gh pr merge --merge --match-head-commit`) and the
//                   issue's close, or, for an approved PR that conflicts
//                   with its base, the PR marked a draft for Fix. GitHub
//                   refusing the merge because the base moved goes to Fix
//                   the same way.
//   land-reconcile  settles an unsettled Land as its original run from
//                   reads of the PR and the issue. It never merges or marks
//                   a draft. When the PR merged at the checked head but the
//                   issue still reads open, as when the original close
//                   failed, it closes the issue, once: nothing is ever
//                   merged or closed twice.
//
// One result covers the merge and the close: passed only once GitHub reads
// the PR merged at exactly the checked head and the issue closed, with the
// merge commit as its produced code. A draft PR at that head is a refused
// result whose evidence says why, which wakes Fix. Anything that can't be
// read back stays unknown and keeps the turn.

import type { Config } from "../config.ts";
import type { LandEvidence, TargetState } from "../domain.ts";
import { LAND_EVIDENCE } from "../domain.ts";
import { gh, issueState } from "../github.ts";
import { OpsError } from "../ops-error.ts";
import type { PullRequest } from "../revision.ts";
import { pullRequest } from "../revision.ts";
import { landCheck } from "../tasks/land.ts";
import { assertLandTurn, releaseSettledTurn } from "../tasks/turn.ts";
import { fetchCommits, isAncestor, readTarget } from "../tasks/view.ts";
import { historicalPrFor } from "./prs.ts";
import type { TaskOpSpec } from "./task-guard.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openReconciliation, openRun, settled } from "./task-run.ts";

const FIRST_LINE = /^.*$/mu;

// An outcome and the receipt evidence it settles with.
interface Settlement {
  outcome: EffectOutcome;
  evidence?: LandEvidence;
}

function headOf(run: OpenRun): string {
  const { binding } = run;
  if (!("revision" in binding)) {
    throw new OpsError("a Land binding binds a revision");
  }
  return binding.revision.code;
}

function failed(reason: string): Settlement {
  return { outcome: { verdict: "failed", reason } };
}

function unknown(reason: string): Settlement {
  return { outcome: { verdict: "unknown", reason } };
}

function firstLine(text: string): string {
  return FIRST_LINE.exec(text.trim())?.[0] ?? "";
}

// How a PR that GitHub reads merged settles: passed once it merged exactly
// `head` and the issue reads closed.
function mergedSettlement(
  run: OpenRun,
  pr: PullRequest,
  head: string,
): Settlement {
  const { number } = run;
  if (pr.headSha !== head || pr.mergeCommit === null) {
    return failed(`PR #${pr.number} merged at ${pr.headSha}, not ${head}`);
  }
  const state = issueState(run.cfg, number);
  if (state !== "closed") {
    return unknown(
      `PR #${pr.number} merged ${head} as ${pr.mergeCommit}, but #${number} reads ${String(state)}`,
    );
  }
  return {
    outcome: {
      verdict: "passed",
      reason: `merged PR #${pr.number} at ${head} as ${pr.mergeCommit} and closed #${number}`,
      produced: pr.mergeCommit,
    },
    evidence: LAND_EVIDENCE.parse({
      outcome: "merged",
      pr: pr.number,
      head,
      mergeCommit: pr.mergeCommit,
      issueClosed: true,
    }),
  };
}

// How a PR that GitHub reads as a draft at `head` settles: refused, for
// Fix, with why Land found it conflicting with `base`.
function draftSettlement(
  pr: PullRequest,
  head: string,
  conflict: { base: TargetState; reason: string },
): Settlement | null {
  if (pr.state !== "OPEN" || !pr.draft || pr.headSha !== head) {
    return null;
  }
  return {
    outcome: {
      verdict: "refused",
      reason: `${conflict.reason}; marked PR #${pr.number} a draft for Fix`,
    },
    evidence: LAND_EVIDENCE.parse({
      outcome: "conflict",
      pr: pr.number,
      head,
      base: conflict.base,
      reason: conflict.reason,
    }),
  };
}

// Marks the approved, conflicting PR a draft, so Fix becomes ready.
function markDraft(
  run: OpenRun,
  pr: number,
  conflict: { base: TargetState; reason: string },
): Settlement {
  const { cfg, number } = run;
  const head = headOf(run);
  const asked = gh(
    cfg,
    "landing",
    ["pr", "ready", String(pr), "-R", cfg.repo, "--undo"],
    // The Land attempt recorded before this reconciles it.
    { allowFail: true, reconciles: true },
  );
  const now = pullRequest(cfg, number, pr);
  const drafted = draftSettlement(now, head, conflict);
  if (drafted !== null) {
    return drafted;
  }
  return failed(
    `${conflict.reason}, and PR #${pr} could not be marked a draft: ${firstLine(asked.stderr) || "it reads ready"}`,
  );
}

// The base as it is now, and whether `head` contains it.
function baseNow(
  run: OpenRun,
  head: string,
): { base: TargetState; contains: boolean } {
  const { cfg, evidence } = run;
  const base = readTarget(cfg, evidence.clone);
  fetchCommits(cfg, evidence.clone, [base.branch], [base.commit, head]);
  return { base, contains: isAncestor(evidence.clone, base.commit, head) };
}

// Why GitHub refused the merge: a base the head no longer contains, or a
// conflict with it, goes to Fix; anything else merged nothing.
function refusedMerge(run: OpenRun, pr: number, stderr: string): Settlement {
  const head = headOf(run);
  const now = pullRequest(run.cfg, run.number, pr);
  if (now.state === "MERGED") {
    return mergedSettlement(run, now, head);
  }
  const why = firstLine(stderr) || "no reason given";
  if (now.state === "OPEN" && now.headSha === head) {
    const { base, contains } = baseNow(run, head);
    if (now.mergeable === "CONFLICTING" || !contains) {
      return markDraft(run, pr, {
        base,
        reason: `GitHub refused to merge PR #${pr} at ${head} into ${base.branch} at ${base.commit}: ${why}`,
      });
    }
  }
  return failed(`nothing merged: GitHub refused to merge PR #${pr}: ${why}`);
}

// Closes the issue of a merged PR, unless it no longer reads open: GitHub
// closed it for the PR's closing reference, or an earlier close landed.
function closeIssue(run: OpenRun, pr: PullRequest): void {
  const { cfg, number } = run;
  if (issueState(cfg, number) !== "open") {
    return;
  }
  gh(
    cfg,
    "landing",
    [
      "issue",
      "close",
      String(number),
      "-R",
      cfg.repo,
      "--reason",
      "completed",
      "--comment",
      `Merged PR #${pr.number} into ${cfg.baseBranch} as ${String(pr.mergeCommit)}.`,
    ],
    { allowFail: true, reconciles: true },
  );
}

// The one merge of the PR at exactly the checked head, then the close.
function mergePr(run: OpenRun, pr: number): Settlement {
  const { cfg, number } = run;
  const head = headOf(run);
  const merged = gh(
    cfg,
    "landing",
    [
      "pr",
      "merge",
      String(pr),
      "-R",
      cfg.repo,
      "--merge",
      "--match-head-commit",
      head,
    ],
    // The Land attempt recorded before this merge reconciles it.
    { allowFail: true, reconciles: true },
  );
  const now = pullRequest(cfg, number, pr);
  if (now.state !== "MERGED") {
    if (merged.code === 0) {
      return unknown(`gh merged PR #${pr}, but GitHub reads it ${now.state}`);
    }
    return refusedMerge(run, pr, merged.stderr);
  }
  closeIssue(run, now);
  return mergedSettlement(run, now, head);
}

function landTask(cfg: Config, request: unknown): EffectOutcome {
  const run = openRun(cfg, request, "land", "land-task");
  assertLandTurn(cfg, run.number);
  const check = landCheck(cfg, run.evidence, run.binding);
  let settlement: Settlement;
  if (check.state === "unmet") {
    settlement = failed(`nothing merged: ${check.reason}`);
  } else if (check.state === "conflict") {
    settlement = markDraft(run, check.pr, {
      base: run.evidence.view.target,
      reason: check.reason,
    });
  } else {
    settlement = mergePr(run, check.pr);
  }
  settled(run, settlement.outcome, settlement.evidence);
  releaseSettledTurn(cfg, run.number);
  return settlement.outcome;
}

// The original run's outcome from reads: a PR merged at its head passed
// once the issue reads closed, closing it first if it still reads open; a
// draft at its head was its conflict; an open PR otherwise, or a closed
// one, merged nothing.
function reconciled(run: OpenRun): Settlement {
  const head = headOf(run);
  const pr = historicalPrFor(run.cfg, run.number);
  if (pr === null) {
    return failed(`nothing merged: #${run.number} has no PR`);
  }
  const now = pullRequest(run.cfg, run.number, pr);
  if (now.state === "MERGED") {
    if (now.headSha === head && now.mergeCommit !== null) {
      closeIssue(run, now);
    }
    return mergedSettlement(run, now, head);
  }
  const drafted = draftSettlement(now, head, {
    base: baseNow(run, head).base,
    reason: `PR #${pr} reads a draft at ${head} after Land found it conflicting with its base`,
  });
  if (drafted !== null) {
    return drafted;
  }
  return failed(`nothing merged: PR #${pr} is ${now.state} and unmerged`);
}

function landReconcile(cfg: Config, request: unknown): EffectOutcome {
  const run = openReconciliation(cfg, request, "land", "land-reconcile");
  const { outcome, evidence } = reconciled(run);
  const linked: EffectOutcome = {
    ...outcome,
    reason: `reconciled by ${run.reconciler}: ${outcome.reason}`,
  };
  settled(run, linked, evidence);
  releaseSettledTurn(cfg, run.number);
  return linked;
}

// Land's ops, which ops/task-ops.ts serves.
const LAND_OPS: readonly TaskOpSpec[] = [
  { name: "land-task", kind: "substantive", op: landTask },
  { name: "land-reconcile", kind: "finalization", op: landReconcile },
];

export { LAND_OPS };
