// The author (`author-maintains-gherkin`): one read-only session that reads
// the filtered issue, AGENTS.md and the repo's docs, then either writes the
// issue's behaviour as Gherkin in one signed comment, edited in place, or
// asks its questions. It never splits, approves, or writes tests, stubs or repo files.

import { GHERKIN_KEY, gherkinBody } from "../../gherkin-comment.ts";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { Stage } from "../../stages.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import type { AuthorReply } from "../replies.ts";
import { AUTHOR_REPLY } from "../replies.ts";
import { authorTask } from "./task.ts";

type GherkinReply = Extract<AuthorReply, { outcome: "gherkin" }>;

// Where the issue goes once the Gherkin is posted: back to the stage it was
// sent from when the behaviour is unchanged, else to implement, since any
// work or review after the author was against the old Gherkin.
function nextStage(state: IssueState, changed: boolean): Stage {
  if (changed || state.resumeStage === null) {
    return "implement";
  }
  return state.resumeStage;
}

async function postGherkin(
  ctx: RoleContext,
  reply: GherkinReply,
): Promise<RoleEnd> {
  const current = ctx.inputs.gherkin;
  const changed =
    current === null ||
    reply.changed ||
    current.gherkin.trim() !== reply.gherkin.trim();
  let rev = 1;
  if (current !== null) {
    rev = current.rev + Number(changed);
  }
  const inputs = ctx.inputs.revision;
  const commentId = await ctx.post({
    key: GHERKIN_KEY,
    on: "issue",
    role: "author",
    body: gherkinBody(reply, { rev, inputs }),
  });
  const stage = nextStage(ctx.state, changed);
  const state: IssueState = {
    ...ctx.state,
    stage,
    authorUsed: true,
    resumeStage: null,
    gherkin: { commentId, rev, inputs },
    // The questions, if any were asked, are answered by this Gherkin.
    asked: null,
  };
  let what = `kept Gherkin revision ${rev}`;
  if (changed) {
    what = `wrote Gherkin revision ${rev}`;
  }
  return {
    kind: "next",
    state: withLog(state, `${what}; on to ${stage}`, new Date()),
  };
}

const authorRole: Role = async (ctx: RoleContext): Promise<RoleEnd> => {
  const result = await ctx.session({
    agent: "issue-pipeline-author",
    model: ctx.cfg.models.author,
    task: authorTask(ctx),
    schema: AUTHOR_REPLY,
    commits: false,
  });
  if (!result.ok) {
    if (result.transient) {
      return { kind: "deferred", error: result.error };
    }
    return {
      kind: "stop",
      code: "error",
      reason: `the author's session failed: ${result.error}`,
      state: ctx.state,
    };
  }
  const reply = AUTHOR_REPLY.parse(result.reply);
  if (reply.outcome === "needs-info") {
    // The job records the inputs revision the questions are asked at.
    return {
      kind: "ask",
      questions: reply.questions,
      state: { ...ctx.state, stage: "author", authorUsed: true },
    };
  }
  return await postGherkin(ctx, reply);
};

export { authorRole };
