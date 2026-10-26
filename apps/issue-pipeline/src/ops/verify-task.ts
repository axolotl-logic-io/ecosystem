// Verify's ops (tasks/verify.ts), on the v2 records:
//
//   verify-task       for this action's own recorded Verify attempt: every
//                     prerequisite again, the PR's head still exactly the
//                     bound code, the full checks on it (verify-checks.ts)
//                     and its required CI (verify-ci.ts); then one review of
//                     the session's findings and those results, submitted
//                     against that head through the landing account
//                     (verify-review.ts). Its verdict mirrors the review:
//                     passed for an approval, refused for a request for
//                     changes. A run that can't judge the head, because it
//                     moved or its checks or CI can't be read, fails and
//                     submits nothing.
//   verify-unjudged   records a failed run whose session never judged the
//                     head, and submits nothing.
//   verify-reconcile  settles an unsettled Verify as its original run from
//                     one read of the PR's reviews: that run's own review
//                     on the head settles it as the review says, and no
//                     review fails it. It never submits a review.
//
// ops/task-ops.ts serves every op listed here.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { VerifyEvidence } from "../domain.ts";
import { VERIFY_EVIDENCE } from "../domain.ts";
import { OpsError } from "../ops-error.ts";
import type { SubmittedReview } from "../pr-reviews.ts";
import { pullRequest } from "../revision.ts";
import { unsupportedTeardown } from "../runtime/preparation.ts";
import { notCurrent } from "../tasks/module.ts";
import { MODULES } from "../tasks/modules.ts";
import { VERIFY_REPLY } from "../tasks/verify.ts";
import { taskEvidence } from "../tasks/view.ts";
import { historicalPrFor, openPrFor } from "./prs.ts";
import type { TaskOpSpec } from "./task-guard.ts";
import type { EffectOutcome, OpenRun } from "./task-run.ts";
import { openReconciliation, openRun, settled } from "./task-run.ts";
import type { Checked } from "./verify-checks.ts";
import { changeBase, checkedAt } from "./verify-checks.ts";
import { requiredCi } from "./verify-ci.ts";
import type { ReviewCounts, ReviewFinding } from "./verify-review.ts";
import {
  commentable,
  planReview,
  postedReview,
  submitReview,
} from "./verify-review.ts";

const TASK_REQUEST = z.looseObject({ reply: VERIFY_REPLY });
const UNJUDGED_REQUEST = z.looseObject({ reason: z.string().min(1) });

function revisionOf(run: OpenRun): { code: string; target: string } {
  if (!("revision" in run.binding)) {
    throw new OpsError("a Verify binding binds a revision");
  }
  return {
    code: run.binding.revision.code,
    target: run.binding.target.commit,
  };
}

// The item's open PR with exactly `code` as its head, or why it has none.
function prOnHead(
  cfg: Config,
  number: number,
  code: string,
): { pr: number } | { unmet: string } {
  try {
    const pr = openPrFor(cfg, number);
    if (pr === undefined) {
      return { unmet: `#${String(number)} has no open PR to review` };
    }
    const { headSha } = pullRequest(cfg, number, pr);
    if (headSha !== code) {
      return { unmet: `PR #${String(pr)}'s head is ${headSha}, not ${code}` };
    }
    return { pr };
  } catch (error) {
    if (error instanceof Error) {
      return { unmet: `the item's PR is unreadable: ${error.message}` };
    }
    throw error;
  }
}

// Why the run's review would not be of the current revision and target
// after the checks, or null.
function moved(run: OpenRun): string | null {
  const now = taskEvidence(run.cfg, run.number, run.evidence.clone);
  return notCurrent(now, run.binding);
}

// The checks' and CI's findings beside the session's: each failure is a
// change the head needs, so it blocks.
function checkFindings(
  code: string,
  checked: Checked,
  ciFailure: string | null,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const failing = checked.checks.filter((check) => !check.pass);
  if (failing.length > 0) {
    findings.push({
      body: `The full checks failed on ${code}: ${failing.map((check) => check.id).join(", ")}.`,
      blocking: true,
      security: false,
    });
  }
  if (ciFailure !== null) {
    findings.push({
      body: `Required CI failed: ${ciFailure}.`,
      blocking: true,
      security: false,
    });
  }
  return findings;
}

function counted(count: number, what: string): string {
  if (count === 1) {
    return `1 ${what}`;
  }
  return `${String(count)} ${what}s`;
}

function verdictOf(
  code: string,
  counts: ReviewCounts,
  approved: boolean,
): Pick<EffectOutcome, "verdict" | "reason"> {
  const nits = counted(counts.nits, "nit");
  if (approved) {
    return {
      verdict: "passed",
      reason: `Verify approved ${code} with ${nits}`,
    };
  }
  let security = "";
  if (counts.security) {
    security = ", a Security finding among them,";
  }
  return {
    verdict: "refused",
    reason: `Verify requested changes on ${code}: ${counted(counts.blocking, "blocking finding")}${security} and ${nits}`,
  };
}

// What a review of the run's head settles: its verdict, and the submitted
// review as evidence when it judged the head.
interface Reviewed {
  outcome: EffectOutcome;
  evidence?: VerifyEvidence;
}

// Reviews the run's head, once its checks and CI are judged.
function reviewed(
  run: OpenRun,
  reply: z.infer<typeof VERIFY_REPLY>,
  checked: Checked,
): Reviewed {
  const { cfg, number, evidence } = run;
  const { code, target } = revisionOf(run);
  const ci = requiredCi(cfg, number, code);
  if (ci.state === "pending" || ci.state === "unjudged") {
    return {
      outcome: {
        verdict: "failed",
        reason: `nothing reviewed: required CI can't be judged: ${ci.reason}`,
      },
    };
  }
  const stale = moved(run);
  if (stale !== null) {
    return {
      outcome: {
        verdict: "failed",
        reason: `moved during the checks: ${stale}`,
      },
    };
  }
  const head = prOnHead(cfg, number, code);
  if ("unmet" in head) {
    return {
      outcome: { verdict: "failed", reason: `nothing reviewed: ${head.unmet}` },
    };
  }
  let ciFailure: string | null = null;
  if (ci.state === "failing") {
    ciFailure = ci.reason;
  }
  const findings: ReviewFinding[] = [
    ...reply.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      body: finding.body,
      blocking: finding.severity === "blocking",
      security: finding.security,
    })),
    ...checkFindings(code, checked, ciFailure),
  ];
  const ranges = commentable(
    evidence.clone,
    changeBase(evidence.clone, target, code),
    code,
  );
  const planned = planReview(
    run.attempt.run.id,
    reply.summary,
    findings,
    ranges,
  );
  const review = submitReview(cfg, head.pr, code, planned);
  return {
    outcome: verdictOf(code, planned.counts, review.state === "APPROVED"),
    evidence: { review, ...planned.counts },
  };
}

function verifyTask(cfg: Config, request: unknown): EffectOutcome {
  const run = openRun(cfg, request, "verify", "verify-task");
  const { reply } = TASK_REQUEST.parse(request);
  const teardown = unsupportedTeardown(cfg, MODULES.verify.definition, "act");
  if (teardown !== null) {
    throw new OpsError(`verify-task refused: ${teardown}`);
  }
  const unmet = MODULES.verify.prerequisite(cfg, run.evidence, run.binding);
  if (unmet !== null) {
    return settled(run, {
      verdict: "failed",
      reason: `nothing reviewed: ${unmet}`,
    });
  }
  const checked = checkedAt(run);
  if (checked.retained !== null) {
    return settled(run, {
      verdict: "failed",
      reason: `nothing reviewed: the checks changed tracked files; their checkout and patch are retained in ${checked.retained}`,
    });
  }
  const { outcome, evidence } = reviewed(run, reply, checked);
  return settled(run, outcome, evidence);
}

// The evidence of a review the landing account submitted, or null when it
// no longer approves or requests changes on exactly one head.
function evidenceOf(
  review: SubmittedReview,
  counts: ReviewCounts,
): VerifyEvidence | null {
  const parsed = VERIFY_EVIDENCE.safeParse({
    review: {
      id: review.id,
      pr: review.pr,
      commit: review.commit,
      state: review.state,
    },
    ...counts,
  });
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function verifyUnjudged(cfg: Config, request: unknown): EffectOutcome {
  const run = openRun(cfg, request, "verify", "verify-unjudged");
  const { reason } = UNJUDGED_REQUEST.parse(request);
  return settled(run, { verdict: "failed", reason });
}

function verifyReconcile(cfg: Config, request: unknown): EffectOutcome {
  const run = openReconciliation(cfg, request, "verify", "verify-reconcile");
  const { code } = revisionOf(run);
  const original = run.attempt.run.id;
  const pr = historicalPrFor(cfg, run.number);
  if (pr === null) {
    return settled(run, {
      verdict: "failed",
      reason: `reconciled by ${run.reconciler}: #${String(run.number)} has no PR, so run ${original} reviewed nothing`,
    });
  }
  const posted = postedReview(cfg, pr, original, code);
  if (posted.status !== "ok") {
    return {
      verdict: "unknown",
      reason: `PR #${String(pr)}'s reviews are unreadable; Verify run ${original} stays unsettled`,
    };
  }
  if (posted.value === null) {
    return settled(run, {
      verdict: "failed",
      reason: `reconciled by ${run.reconciler}: run ${original} submitted no review of ${code}`,
    });
  }
  const { review, counts } = posted.value;
  const evidence = evidenceOf(review, counts);
  if (evidence === null) {
    return {
      verdict: "unknown",
      reason: `run ${original}'s review ${String(review.id)} of ${code} is ${review.state}; reconcile it explicitly`,
    };
  }
  const outcome = verdictOf(code, counts, evidence.review.state === "APPROVED");
  return settled(
    run,
    {
      ...outcome,
      reason: `${outcome.reason} (reconciled by ${run.reconciler})`,
    },
    evidence,
  );
}

// Verify's ops, which ops/task-ops.ts serves.
const VERIFY_OPS: readonly TaskOpSpec[] = [
  { name: "verify-task", kind: "substantive", op: verifyTask },
  { name: "verify-unjudged", kind: "finalization", op: verifyUnjudged },
  { name: "verify-reconcile", kind: "finalization", op: verifyReconcile },
];

export { VERIFY_OPS };
