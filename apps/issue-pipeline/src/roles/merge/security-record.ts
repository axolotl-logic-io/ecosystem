// Separate receipt slots retain original candidate authority across policy movement.
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import { legacyWikiOf } from "../../land-provenance.ts";
import { policyRevision } from "../../project-policy.ts";
import type { ReviewedTarget } from "../../reviewed-target.ts";
import type { IssueState, Revision } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import type { SecurityReviewReply } from "../replies.ts";
import type { Step } from "../writer-session.ts";
import { ended } from "../writer-session.ts";
import { logged } from "./returns.ts";

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

// A finding prevents a new Land; historical already-landed code stays landed.
function securityStop(state: IssueState, finding: Finding): RoleEnd {
  const { category, reason } = finding;
  return {
    kind: "stop",
    code: category,
    reason: `security review (${category}): ${reason}. This revision cannot merge or complete. Existing merged code stays merged; lifting this stop does not reroll Security`,
    state,
  };
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

// The receipt of `reply`, the review of exactly `revision`: its comment
// posted and the receipt saved, approval or rejection, before anything
// publishes or stops.
async function recorded(
  ctx: RoleContext,
  state: IssueState,
  {
    revision,
    reply,
    target,
    resultTarget,
  }: {
    revision: Revision;
    reply: SecurityReviewReply;
    target?: ReviewedTarget | undefined;
    resultTarget?: ReviewedTarget | undefined;
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
  if (target !== undefined) {
    security = { ...security, phase: "candidate", target };
  }
  let receipt: IssueState = { ...state, security };
  if (resultTarget !== undefined) {
    receipt = {
      ...state,
      resultSecurity: {
        revision: { ...revision, ...policyRevision(ctx.cfg) },
        commentId,
        finding,
        target: resultTarget,
      },
    };
  }
  const reviewed = logged(receipt, entry);
  await ctx.save(reviewed);
  if (finding !== null) {
    return ended(securityStop(reviewed, finding));
  }
  return { ok: true, value: reviewed };
}

export { recorded, securityStop };
