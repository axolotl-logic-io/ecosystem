// The reviewer (`one-review-session`): one read-only session per round over
// the code and wiki change, the Gherkin, AGENTS.md and the previous findings.
// Its verdict binds the exact revision it saw (`approval-is-for-one-revision`):
// the role reads the code head, the wiki head and the trusted inputs before
// and after the session and discards a verdict when any of them moved. A
// security finding stops the issue whatever the verdict says.

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { CodeMerged, Finding, IssueState, Revision } from "../../state.ts";
import { withLog } from "../../state.ts";
import type { ReviewerReply } from "../replies.ts";
import { REVIEWER_REPLY } from "../replies.ts";
import type { CurrentRevision } from "./source.ts";
import { codeMergeConfirmed, currentRevision, sameRevision } from "./source.ts";
import type { PreparedReview } from "./task.ts";
import { findingLine, reviewerTask } from "./task.ts";

const SHORT_SHA_LENGTH = 12;

const VERDICT_TITLES: Readonly<Record<Verdict, string>> = {
  approve: "approved",
  changes: "changes requested",
};

// The config's bound on review rounds; the config's defaults fill it in.
const FIX_ROUNDS = z.looseObject({
  maxFixRounds: z.number().int().nonnegative(),
});

const PREPARED = z.looseObject({
  headSha: z.string(),
  diffPath: z.string().min(1),
  bundlePath: z.string().min(1),
  changedFiles: z.array(z.string()),
});

type Prepared = PreparedReview & { headSha: string };
type Verdict = ReviewerReply["verdict"];

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

// The state with the last verdict voided, keeping its revision for the record.
function voided(state: IssueState): IssueState {
  return { ...state, review: { ...state.review, verdict: null } };
}

// The trusted inputs moved past the Gherkin: the author goes first, and the
// issue comes back to review.
function toAuthor(state: IssueState, why: string): RoleEnd {
  const next: IssueState = {
    ...voided(state),
    stage: "author",
    resumeStage: "review",
  };
  return { kind: "next", state: logged(next, `${why}; back to the author`) };
}

function failed(state: IssueState, reason: string): RoleEnd {
  return { kind: "stop", code: "error", reason, state };
}

async function prepare(
  ctx: RoleContext,
  round: number,
  codeMerged: CodeMerged | null,
): Promise<Prepared> {
  const reply = await ctx.op("prepare-review", {
    tag: `r${round}`,
    sinceSha: null,
    codeMerged,
  });
  const parsed = PREPARED.safeParse(reply);
  if (!parsed.success) {
    throw new Error(
      `prepare-review: unexpected reply: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

// The reply's findings with ids, numbered on from the last round's.
function numbered(
  previous: readonly Finding[],
  reply: ReviewerReply,
): Finding[] {
  const last = Math.max(0, ...previous.map((finding) => finding.id));
  return reply.findings.map((finding, index) => ({
    ...finding,
    id: last + index + 1,
  }));
}

function short(sha: string | null): string {
  if (sha === null) {
    return "none";
  }
  return `\`${sha.slice(0, SHORT_SHA_LENGTH)}\``;
}

function reviewBody(
  round: number,
  verdict: Verdict,
  reply: ReviewerReply,
  { findings, revision }: { findings: readonly Finding[]; revision: Revision },
): string {
  const lines = [
    `## Review, round ${round}: ${VERDICT_TITLES[verdict]}`,
    "",
    reply.summary,
    "",
  ];
  if (findings.length > 0) {
    lines.push("### Findings", "", ...findings.map(findingLine), "");
  }
  lines.push(
    `Reviewed code ${short(revision.code)}, wiki ${short(revision.wiki)} and trusted inputs ${short(revision.inputs)}. A change to any of them voids this verdict.`,
  );
  return lines.join("\n");
}

// A security finding stops the issue for a person, whatever the verdict, and
// even when the head moved during the review: the finding is about code the
// pipeline was about to merge.
function securityStop(
  state: IssueState,
  reply: ReviewerReply,
  revision: Revision,
): RoleEnd | null {
  if (reply.security === null) {
    return null;
  }
  const { category, reason } = reply.security;
  const round = state.review.round + 1;
  const findings = numbered(state.review.findings, reply);
  const stopped: IssueState = {
    ...state,
    review: { ...state.review, verdict: null, findings, revision },
  };
  return {
    kind: "stop",
    code: category,
    reason: `security review (${category}): ${reason}`,
    state: logged(stopped, `review round ${round}: security ${category}`),
  };
}

// The verdict for exactly `revision`: approve to merge, or changes back to
// implement until the fix rounds run out.
async function recordVerdict(
  ctx: RoleContext,
  reply: ReviewerReply,
  revision: Revision,
): Promise<RoleEnd> {
  const { state } = ctx;
  const round = state.review.round + 1;
  const findings = numbered(state.review.findings, reply);
  const blocking = findings.some((finding) => finding.severity === "blocking");
  // An approval with a blocking finding contradicts itself: it is changes.
  let verdict: Verdict = "changes";
  if (reply.verdict === "approve" && !blocking) {
    verdict = "approve";
  }
  // A change that lives only in the wiki has no PR.
  let on: "issue" | "pr" = "pr";
  if (state.pr === null) {
    on = "issue";
  }
  const commentId = await ctx.post({
    key: "review",
    on,
    role: "reviewer",
    body: reviewBody(round, verdict, reply, { findings, revision }),
  });
  if (verdict === "approve") {
    const approved: IssueState = {
      ...state,
      stage: "merge",
      review: { ...state.review, verdict, commentId, findings, revision },
    };
    return {
      kind: "next",
      state: logged(approved, `review round ${round}: approved; on to merge`),
    };
  }
  const review = { ...state.review, verdict, commentId, findings, revision };
  const { maxFixRounds } = FIX_ROUNDS.parse(ctx.cfg);
  if (state.review.round >= maxFixRounds) {
    return {
      kind: "stop",
      code: "review-rounds",
      reason: `blocking findings remain after ${maxFixRounds} fix rounds`,
      state: { ...state, review },
    };
  }
  const changes: IssueState = {
    ...state,
    stage: "implement",
    review: { ...review, round },
  };
  return {
    kind: "next",
    state: logged(changes, `review round ${round}: changes; back to implement`),
  };
}

// Why `current` can't be reviewed now, or null when it can.
function notReviewable(
  ctx: RoleContext,
  current: CurrentRevision,
): RoleEnd | null {
  const { state } = ctx;
  const { gherkin } = ctx.inputs;
  if (gherkin === null || gherkin.inputs !== current.revision.inputs) {
    return toAuthor(state, "the trusted inputs changed since the Gherkin");
  }
  const { codeMerged } = state;
  if (codeMerged !== null && !codeMergeConfirmed(current, codeMerged)) {
    return failed(
      state,
      `GitHub doesn't confirm PR #${codeMerged.pr} merged as ${codeMerged.sha}, as the claim recorded`,
    );
  }
  if (current.revision.code === null && current.revision.wiki === null) {
    return failed(state, "nothing to review: no code head and no wiki commits");
  }
  return null;
}

const reviewerRole: Role = async (ctx: RoleContext): Promise<RoleEnd> => {
  const { state } = ctx;
  const before = await currentRevision(ctx);
  const refused = notReviewable(ctx, before);
  if (refused !== null || ctx.inputs.gherkin === null) {
    return refused ?? toAuthor(state, "the issue has no Gherkin");
  }
  const round = state.review.round + 1;
  const prepared = await prepare(ctx, round, state.codeMerged);
  const { code } = before.revision;
  if (state.codeMerged === null && code !== null && prepared.headSha !== code) {
    return {
      kind: "wait",
      reason: "the code head moved while the review was prepared",
      state,
    };
  }
  const result = await ctx.session({
    agent: "issue-pipeline-reviewer",
    model: ctx.cfg.models.reviewer,
    task: reviewerTask(ctx, {
      gherkin: ctx.inputs.gherkin,
      prepared,
      revision: before.revision,
      round,
      codeMergedSha: state.codeMerged?.sha ?? null,
    }),
    schema: REVIEWER_REPLY,
    commits: false,
  });
  if (!result.ok) {
    if (result.transient) {
      return { kind: "deferred", error: result.error };
    }
    return failed(state, `the reviewer's session failed: ${result.error}`);
  }
  const reply = REVIEWER_REPLY.parse(result.reply);
  const security = securityStop(state, reply, before.revision);
  if (security !== null) {
    return security;
  }
  const after = await currentRevision(ctx);
  if (!sameRevision(before.revision, after.revision)) {
    if (after.revision.inputs !== before.revision.inputs) {
      return toAuthor(state, "the trusted inputs changed during the review");
    }
    return {
      kind: "wait",
      reason:
        "the code or wiki head moved during the review, so its verdict is discarded; the next job reviews the new head",
      state: logged(voided(state), "review discarded: the head moved"),
    };
  }
  return await recordVerdict(ctx, reply, after.revision);
};

export { reviewerRole };
