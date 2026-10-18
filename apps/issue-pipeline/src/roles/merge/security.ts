// The security review of the merged result: a fresh read-only Reviewer
// session after the code merge (or, for a change that lives only in the
// wiki, with no code merge) over exactly the merge commit GitHub confirmed
// and the wiki head about to publish, in the four security categories. Its
// receipt (`state.security`) binds that revision, and is saved before
// anything publishes: an approval lets the wiki publish and the issue
// complete; a rejection stops the issue with its category, and stops it
// again for the same revision however often the stop is lifted. The merged
// code stays merged: nothing here undoes it or touches `main`.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { unreadableReply } from "../../job/role-context.ts";
import type { CodeMerged, IssueState, Revision } from "../../state.ts";
import { sameRevision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { SecurityReviewReply } from "../replies.ts";
import { SECURITY_REVIEW_REPLY } from "../replies.ts";
import { currentRevision } from "../revision-source.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop } from "../writer-session.ts";
import { logged, toAuthor, waiting } from "./returns.ts";
import { securityReviewTask } from "./task.ts";

const PREPARED = z.looseObject({
  headSha: z.string(),
  diffPath: z.string().min(1),
  bundlePath: z.string().min(1),
  changedFiles: z.array(z.string()),
});

type Finding = NonNullable<SecurityReviewReply["security"]>;

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

// The stop for a security finding on the merged result.
function securityStop(state: IssueState, finding: Finding): RoleEnd {
  const { category, reason } = finding;
  return {
    kind: "stop",
    code: category,
    reason: `security review (${category}) of the merged result: ${reason}. The merged code stays merged and the wiki is not published; a fix needs a new change, since lifting this stop reviews nothing again`,
    state,
  };
}

// The merged result the review reads, prepared for exactly `revision`.
async function prepare(
  ctx: RoleContext,
  revision: Revision,
  codeMerged: CodeMerged | null,
): Promise<z.infer<typeof PREPARED>> {
  const tag = `security-${short(revision.code ?? revision.wiki)}`;
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
  const lines = [`## Security review of the merged result: ${title}`, ""];
  lines.push(reply.summary, "");
  if (reply.security !== null) {
    lines.push(`**${reply.security.category}:** ${reply.security.reason}`, "");
  }
  lines.push(
    `Reviewed merged code ${short(revision.code)}, wiki ${short(revision.wiki)} and trusted inputs ${short(revision.inputs)}. This review judged security alone; hardening owned the design, correctness and tests.`,
  );
  return lines.join("\n");
}

// What the security review reviews: `revision`, the merged result its
// receipt binds, with `codeMerged` the code merge GitHub confirmed (null
// for a change that lives only in the wiki); `still` says whether the
// revision read after the session is still that result.
interface MergedResult {
  revision: Revision;
  codeMerged: CodeMerged | null;
  still: (after: Revision) => boolean;
}

// The security receipt for exactly `revision`: the saved one when it is for
// this revision, or a fresh review's, saved before it returns. Ends with the
// category's stop on a finding, the saved one included.
async function securityReviewed(
  ctx: RoleContext,
  state: IssueState,
  { revision, codeMerged, still }: MergedResult,
): Promise<Step<IssueState>> {
  const saved = state.security;
  if (saved !== null && sameRevision(saved.revision, revision)) {
    if (saved.finding === null) {
      return { ok: true, value: state };
    }
    return ended(securityStop(state, saved.finding));
  }
  const prepared = await prepare(ctx, revision, codeMerged);
  if (codeMerged !== null && prepared.headSha !== codeMerged.sha) {
    return ended(
      errorStop(
        state,
        `prepare-review read ${prepared.headSha}, not the merge commit ${codeMerged.sha}`,
      ),
    );
  }
  const result = await ctx.session({
    agent: "issue-pipeline-reviewer",
    model: ctx.cfg.models.reviewer,
    task: securityReviewTask(ctx, { prepared, revision }),
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
  const { revision: after } = await currentRevision(ctx);
  if (!still(after)) {
    if (after.inputs !== revision.inputs) {
      return ended(
        toAuthor(state, "the trusted inputs changed during the security review"),
      );
    }
    return ended(
      waiting(
        logged(state, "security review discarded: the revision moved"),
        "the code or wiki head moved during the security review, so it is discarded",
      ),
    );
  }
  let on: "issue" | "pr" = "pr";
  if (state.pr === null) {
    on = "issue";
  }
  const commentId = await ctx.post({
    key: `security-${short(revision.code ?? revision.wiki)}`,
    on,
    role: "reviewer",
    body: reviewBody(reply, revision),
  });
  const finding = reply.security;
  let entry = "security review of the merged result: no finding";
  if (finding !== null) {
    entry = `security review of the merged result: ${finding.category}`;
  }
  const reviewed = logged(
    { ...state, security: { revision, commentId, finding } },
    entry,
  );
  await ctx.save(reviewed);
  if (finding !== null) {
    return ended(securityStop(reviewed, finding));
  }
  return { ok: true, value: reviewed };
}

export type { MergedResult };
export { securityReviewed };
