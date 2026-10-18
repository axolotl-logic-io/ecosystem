// One implementor session, and how a step of the role ends: on with a value,
// or with the stage's end.

import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import type { ImplementorReply } from "../replies.ts";
import { IMPLEMENTOR_REPLY } from "../replies.ts";

type Step<T> = { ok: true; value: T } | { ok: false; end: RoleEnd };

function ended<T>(end: RoleEnd): Step<T> {
  return { ok: false, end };
}

function errorStop(state: IssueState, reason: string): RoleEnd {
  return { kind: "stop", code: "error", reason, state };
}

// Runs an implementor session on `task`, as `what` names it. A transient
// failure defers the stage and counts nothing; any other failure stops it.
async function implementorSession(
  ctx: RoleContext,
  state: IssueState,
  { task, what }: { task: string; what: string },
): Promise<Step<ImplementorReply>> {
  const result = await ctx.session({
    agent: "issue-pipeline-implementor",
    model: ctx.cfg.models.implementor,
    task,
    schema: IMPLEMENTOR_REPLY,
    commits: true,
  });
  if (result.ok) {
    return { ok: true, value: IMPLEMENTOR_REPLY.parse(result.reply) };
  }
  if (result.transient) {
    return ended({ kind: "deferred", error: result.error });
  }
  return ended(errorStop(state, `the ${what} session failed: ${result.error}`));
}

// What a reply says, whichever outcome it has.
function replyText(reply: ImplementorReply): string {
  if (reply.outcome === "cannot") {
    return reply.reason;
  }
  return reply.summary;
}

export type { Step };
export { ended, errorStop, implementorSession, replyText };
