// One session that writes, and how a step of a role ends: on with a value,
// or with the stage's end. The Developer writes in development; the
// Reviewer writes while it hardens a change and while it integrates one at
// merge. Every writing session commits only through `pipeline_commit`.

import type {
  RoleContext,
  RoleEnd,
  SessionSpec,
} from "../job/role-context.ts";
import type { IssueState } from "../state.ts";
import type { WriterReply } from "./replies.ts";
import { WRITER_REPLY } from "./replies.ts";

// Which writing session: the Developer's work, or the Reviewer's hardening
// or integration.
type WriterPhase = "development" | "hardening" | "integration";

type Step<T> = { ok: true; value: T } | { ok: false; end: RoleEnd };

function ended<T>(end: RoleEnd): Step<T> {
  return { ok: false, end };
}

function errorStop(state: IssueState, reason: string): RoleEnd {
  return { kind: "stop", code: "error", reason, state };
}

function specOf(ctx: RoleContext, phase: WriterPhase, task: string): SessionSpec {
  if (phase === "development") {
    return {
      agent: "issue-pipeline-implementor",
      model: ctx.cfg.models.implementor,
      task,
      schema: WRITER_REPLY,
      commits: true,
    };
  }
  return {
    agent: "issue-pipeline-reviewer",
    model: ctx.cfg.models.reviewer,
    task,
    schema: WRITER_REPLY,
    commits: true,
    phase,
  };
}

// Runs a writing session of `phase` on `task`, as `what` names it. A
// transient failure defers the stage and counts nothing; any other failure
// stops it.
async function writerSession(
  ctx: RoleContext,
  state: IssueState,
  { phase, task, what }: { phase: WriterPhase; task: string; what: string },
): Promise<Step<WriterReply>> {
  const result = await ctx.session(specOf(ctx, phase, task));
  if (result.ok) {
    return { ok: true, value: WRITER_REPLY.parse(result.reply) };
  }
  if (result.transient) {
    return ended({ kind: "deferred", error: result.error });
  }
  return ended(errorStop(state, `the ${what} session failed: ${result.error}`));
}

// What a reply says, whichever outcome it has.
function replyText(reply: WriterReply): string {
  if (reply.outcome === "cannot") {
    return reply.reason;
  }
  return reply.summary;
}

export type { Step, WriterPhase };
export { ended, errorStop, replyText, writerSession };
