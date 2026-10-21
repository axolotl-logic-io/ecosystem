// Read-only Security over an exact candidate, or historical merged recovery.
import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { unreadableReply } from "../../job/role-context.ts";
import { legacyWikiOf } from "../../merge-provenance.ts";
import type { Candidate } from "../../security-clearance.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { SecurityReviewReply } from "../replies.ts";
import { SECURITY_REVIEW_REPLY } from "../replies.ts";
import { currentRevision } from "../revision-source.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop } from "../writer-session.ts";
import { integrate } from "./integration.ts";
import { logged, toAuthor, waiting } from "./returns.ts";
import { securityReviewTask } from "./task.ts";

const PREPARED = z.looseObject({
  headSha: z.string(),
  baseSha: z.string(),
  diffPath: z.string().min(1),
  bundlePath: z.string().min(1),
  changedFiles: z.array(z.string()),
});

type Finding = NonNullable<SecurityReviewReply["security"]>;

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The key of the security review comment on exactly `revision`. It keeps the
// legacy wiki head's place ("none" for a revision without one), so a comment
// posted before the wiki was removed is still found and edited, not repeated.
function securityCommentKey(revision: Revision): string {
  return `security-${short(revision.code)}-${short(legacyWikiOf(revision))}`;
}

// The stop for a security finding on the merged result.
function securityStop(state: IssueState, finding: Finding): RoleEnd {
  const { category, reason } = finding;
  return {
    kind: "stop",
    code: category,
    reason: `security review (${category}): ${reason}. This revision cannot merge or complete. Existing merged code stays merged; lifting this stop does not reroll Security`,
    state,
  };
}

// The stop again of a saved security rejection of exactly `current`, the
// issue's revision now, with no session: a rejected merged result never
// gets a second review. A receipt of a change that merged no code binds no
// code head. Null when no saved rejection is for `current`.
function rejectedAgain(state: IssueState, current: Revision): RoleEnd | null {
  const saved = state.security;
  if (saved === null || saved.finding === null) {
    return null;
  }
  let compared = current;
  if (saved.revision.code === null) {
    compared = { ...current, code: null };
  }
  if (!sameRevision(saved.revision, compared)) {
    return null;
  }
  return securityStop(state, saved.finding);
}

// The merged result the review reads, prepared for exactly `revision`.
async function prepare(
  ctx: RoleContext,
  revision: Revision,
  codeMerged: CodeMerged | null,
): Promise<z.infer<typeof PREPARED>> {
  const tag = `security-${short(revision.code ?? legacyWikiOf(revision))}`;
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

function reviewBody(reply: SecurityReviewReply, revision: Revision): string {
  let title = "no security finding";
  if (reply.security !== null) {
    title = `stopped (${reply.security.category})`;
  }
  const lines = [`## Security review: ${title}`, ""];
  lines.push(reply.summary, "");
  if (reply.security !== null) {
    lines.push(`**${reply.security.category}:** ${reply.security.reason}`, "");
  }
  lines.push(
    `Reviewed code ${short(revision.code)} and trusted inputs ${short(revision.inputs)}. This review judged security alone; hardening owned the design, correctness and tests.`,
  );
  return lines.join("\n");
}

// What the security review reviews: `revision`, the merged result its
// receipt binds, with `codeMerged` the code merge GitHub confirmed (null
// only for an older completion with no code); `still` says whether the
// revision read after the session is still that result.
interface MergedResult {
  revision: Revision;
  codeMerged: CodeMerged | null;
  still: (after: Revision) => boolean;
  candidate?: Candidate;
}

// A fresh security review of `result`, prepared after the code merge was
// confirmed: discarded when the revision moved while it ran.
async function freshReview(
  ctx: RoleContext,
  state: IssueState,
  { revision, codeMerged, still, candidate }: MergedResult,
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
  if (candidate !== undefined && prepared.baseSha !== candidate.baseSha) {
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
    !still(after) ||
    (candidate !== undefined && fresh.baseSha !== candidate.baseSha)
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

// The receipt of `reply`, the review of exactly `revision`: its comment
// posted and the receipt saved, approval or rejection, before anything
// publishes or stops.
async function recorded(
  ctx: RoleContext,
  state: IssueState,
  {
    revision,
    reply,
    candidate,
  }: {
    revision: Revision;
    reply: SecurityReviewReply;
    candidate?: Candidate | undefined;
  },
): Promise<Step<IssueState>> {
  let on: "issue" | "pr" = "pr";
  if (state.pr === null) {
    on = "issue";
  }
  const commentId = await ctx.post({
    key: securityCommentKey(revision),
    on,
    role: "reviewer",
    body: reviewBody(reply, revision),
  });
  const finding = reply.security;
  let entry = "security review: no finding";
  if (finding !== null) {
    entry = `security review: ${finding.category}`;
  }
  let security: IssueState["security"] = { revision, commentId, finding };
  if (candidate !== undefined) {
    security = { ...security, candidate };
  }
  const reviewed = logged({ ...state, security }, entry);
  await ctx.save(reviewed);
  if (finding !== null) {
    return ended(securityStop(reviewed, finding));
  }
  return { ok: true, value: reviewed };
}

// The security receipt for exactly `result.revision`: the saved one when it
// is for this revision, with no session, or a fresh review's. Ends with the
// category's stop on a finding, the saved one included.
async function securityReviewed(
  ctx: RoleContext,
  state: IssueState,
  result: MergedResult,
): Promise<Step<IssueState>> {
  const { revision, candidate } = result;
  const saved = state.security;
  if (
    saved !== null &&
    sameRevision(saved.revision, revision) &&
    (candidate === undefined ||
      (saved.candidate?.target === candidate.target &&
        saved.candidate.baseSha === candidate.baseSha))
  ) {
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
    candidate,
  });
}

export type { MergedResult };
export { rejectedAgain, securityReviewed };
