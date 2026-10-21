// Read-only Security over an exact candidate, or historical merged recovery.
import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { unreadableReply } from "../../job/role-context.ts";

import { legacyWikiOf } from "../../merge-provenance.ts";
import { configPolicyDigest } from "../../project-policy.ts";
import type { ReviewedTarget } from "../../reviewed-target.ts";
import { targetHolds } from "../../reviewed-target.ts";
import {
  resultReviewTarget,
  sameSecuritySubject,
} from "../../security-clearance.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";

import type { SecurityReviewReply } from "../replies.ts";
import { SECURITY_REVIEW_REPLY } from "../replies.ts";
import { currentRevision } from "../revision-source.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop } from "../writer-session.ts";
import { integrate } from "./integration.ts";
import { logged, toAuthor, toReview, waiting } from "./returns.ts";
import { recorded, securityStop } from "./security-record.ts";
import { securityReviewTask } from "./task.ts";

const PREPARED = z.looseObject({
  headSha: z.string(),
  baseSha: z.string(),
  diffPath: z.string().min(1),
  bundlePath: z.string().min(1),
  changedFiles: z.array(z.string()),
});

// A policy or target change does not remediate known harm in unchanged work.
function rejectedAgain(state: IssueState, current: Revision): RoleEnd | null {
  for (const saved of [state.security, state.resultSecurity]) {
    if (saved !== undefined && saved !== null && saved.finding !== null) {
      let compared = current;
      if (saved.revision.code === null) {
        compared = { ...current, code: null };
      }
      if (sameSecuritySubject(saved.revision, compared)) {
        return securityStop(state, saved.finding);
      }
    }
  }
  return null;
}

// The candidate or historical merged result, prepared at exactly `revision`.
async function prepare(
  ctx: RoleContext,
  revision: Revision,
  codeMerged: CodeMerged | null,
): Promise<z.infer<typeof PREPARED>> {
  const tag = `security-${(revision.code ?? legacyWikiOf(revision))?.slice(0, SHORT_SHA) ?? "none"}`;
  const reply = await ctx.op("prepare-review", {
    tag,
    sinceSha: null,
    codeMerged,
  });
  const parsed = PREPARED.safeParse(reply);
  if (!parsed.success) {
    throw unreadableReply("prepare-review", z.prettifyError(parsed.error));
  }
  return parsed.data;
}

// Candidate provenance is absent only for historical merged recovery.
interface MergedResult {
  revision: Revision;
  codeMerged: CodeMerged | null;
  still: (after: Revision) => boolean;
  target?: ReviewedTarget;
  resultTarget?: ReviewedTarget;
}

function reviewDecisionHolds(
  { revision, still }: Pick<MergedResult, "revision" | "still">,
  after: Revision,
  reply: SecurityReviewReply,
): boolean {
  if (reply.security !== null) {
    return sameSecuritySubject(after, revision);
  }
  return still(after);
}

// Code/input movement discards a verdict; target movement expires only clearance.
async function freshReview(
  ctx: RoleContext,
  state: IssueState,
  { revision, codeMerged, still, target }: MergedResult,
): Promise<Step<SecurityReviewReply>> {
  const prepared = await prepare(ctx, revision, codeMerged);
  if (revision.code !== null && prepared.headSha !== revision.code) {
    return ended(
      errorStop(
        state,
        `prepare-review read ${prepared.headSha}, not the reviewed commit ${revision.code}`,
      ),
    );
  }
  if (target !== undefined && prepared.baseSha !== target.sha) {
    return ended(
      await integrate(ctx, state, {
        rebase: true,
        failing: [],
        why: "the candidate does not include the observed target revision",
      }),
    );
  }
  const result = await ctx.session({
    agent: "issue-pipeline-reviewer",
    model: ctx.cfg.models.reviewer,
    task: securityReviewTask(ctx, { prepared, revision, codeMerged }),
    schema: SECURITY_REVIEW_REPLY,
    commits: false,
    phase: "security-review",
  });
  if (!result.ok) {
    if (result.transient) {
      return ended({ kind: "deferred", error: result.error });
    }
    return ended(
      errorStop(state, `the security review session failed: ${result.error}`),
    );
  }
  const reply = SECURITY_REVIEW_REPLY.parse(result.reply);
  const fresh = await currentRevision(ctx);
  const { revision: after } = fresh;
  if (after.inputs !== revision.inputs) {
    return ended(
      toAuthor(state, "the trusted inputs changed during the security review"),
    );
  }
  if (
    !reviewDecisionHolds({ revision, still }, after, reply) ||
    (reply.security === null &&
      target !== undefined &&
      fresh.baseSha !== target.sha)
  ) {
    return ended(
      waiting(
        logged(state, "security review discarded: the revision moved"),
        "the code head or target moved during the security review, so it is discarded",
      ),
    );
  }
  return { ok: true, value: reply };
}

function candidateGate(
  ctx: RoleContext,
  state: IssueState,
  target: ReviewedTarget | undefined,
): RoleEnd | null {
  if (target !== undefined) {
    if (
      state.mergeAttempt !== null ||
      state.codeMerged !== null ||
      (state.merged !== null && state.merged.code !== null)
    ) {
      return errorStop(
        state,
        "candidate Security cannot run after merge or an uncertain attempt",
      );
    }
    if (
      !(
        targetHolds(ctx.cfg, target, target.sha) &&
        targetHolds(ctx.cfg, state.hardenedTarget, target.sha)
      )
    ) {
      return toReview(
        state,
        "the target context needs fresh hardening and checks",
      );
    }
  }
  return null;
}

function reusableSecurity(
  ctx: RoleContext,
  state: IssueState,
  result: MergedResult,
): NonNullable<IssueState["security"] | IssueState["resultSecurity"]> | null {
  const { revision, target } = result;
  let saved: IssueState["security"] | IssueState["resultSecurity"] =
    state.security;
  if (result.resultTarget !== undefined) {
    saved = state.resultSecurity;
  }
  if (
    saved !== undefined &&
    saved !== null &&
    sameRevision(saved.revision, revision) &&
    ((target === undefined &&
      !("phase" in saved) &&
      (result.resultTarget === undefined ||
        targetHolds(ctx.cfg, saved.target, result.resultTarget.sha))) ||
      (target !== undefined &&
        "phase" in saved &&
        saved.phase === "candidate" &&
        targetHolds(ctx.cfg, saved.target, target.sha)))
  ) {
    return saved;
  }
  return null;
}

// The security receipt for exactly `result.revision`: the saved one when it
// is for this revision, with no session, or a fresh review's. Ends with the
// category's stop on a finding, the saved one included.
async function securityReviewed(
  ctx: RoleContext,
  state: IssueState,
  result: MergedResult,
): Promise<Step<IssueState>> {
  const { revision, target } = result;
  const rejected = rejectedAgain(state, revision);
  if (rejected !== null) {
    return ended(rejected);
  }
  const gate = candidateGate(ctx, state, target);
  if (target !== undefined && revision.policy !== configPolicyDigest(ctx.cfg)) {
    return ended(
      toReview(state, "candidate checking policy needs fresh hardening"),
    );
  }
  const originalTarget = resultReviewTarget(state, revision);
  if (
    result.resultTarget !== undefined &&
    (revision.policy !== configPolicyDigest(ctx.cfg) ||
      originalTarget === null ||
      !targetHolds(ctx.cfg, result.resultTarget, originalTarget.sha))
  ) {
    return ended(
      errorStop(
        state,
        "current-policy result review has no original candidate provenance",
      ),
    );
  }
  if (gate !== null) {
    return ended(gate);
  }
  const saved = reusableSecurity(ctx, state, result);
  if (saved !== null) {
    if (saved.finding === null) {
      return { ok: true, value: state };
    }
    return ended(securityStop(state, saved.finding));
  }
  const reply = await freshReview(ctx, state, result);
  if (!reply.ok) {
    return reply;
  }
  return await recorded(ctx, state, {
    revision,
    reply: reply.value,
    target,
    resultTarget: result.resultTarget,
  });
}

export type { MergedResult };
export { rejectedAgain, securityReviewed };
