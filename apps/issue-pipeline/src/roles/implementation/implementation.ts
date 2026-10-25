// The Developer (`implementor-owns-the-change`): the implement stage's one
// role. One session does the issue's work on the existing branch work, from
// the trusted requirements and any merge return an earlier pipeline left, and the job
// pushes what it committed into the issue's draft PR, which stays a draft.
// The Developer never synchronizes the branch with its base and never owns
// the full verification: the Reviewer hardens and verifies the change next
// (src/roles/reviewer/). Its push makes any earlier hardening, approval or
// integration stale, so it clears them. The landing account records its
// Implementation result before the work moves to review
// (implementation-result.ts). Once the issue's code landed
// or an attempted Land is retained, Developer entry stops before any
// session or operation. Read-only recovery belongs to the merge stage.

import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import {
  DEVELOPER_RECOVERY_REASON,
  developerRecoveryRequired,
  requirementsHold,
  requirementsState,
  usedAuthor,
} from "../../requirements.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import type { Mode } from "../change-task.ts";
import { changeModeOf } from "../change-task.ts";
import { OPEN_PR_REPLY, opReply, START_PR_REPLY } from "../op-replies.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop, writerSession } from "../writer-session.ts";
import { recordImplementation } from "./implementation-result.ts";
import { workTask } from "./task.ts";

const SHORT_SHA = 12;

// The session that does the issue's work; its summary on success.
async function work(
  ctx: RoleContext,
  state: IssueState,
  mode: Mode,
): Promise<Step<string>> {
  const session = await writerSession(ctx, state, {
    phase: "development",
    task: workTask(ctx, mode),
    what: "developer's",
  });
  if (!session.ok) {
    return session;
  }
  const reply = session.value;
  if (reply.outcome === "done") {
    return { ok: true, value: reply.summary };
  }
  if (reply.outcome === "cannot") {
    const reason = `the developer could not do the issue as written: ${reply.reason}`;
    return ended({ kind: "stop", code: "not-doable", reason, state });
  }
  return ended(
    errorStop(
      state,
      `the developer's session replied ${reply.outcome} to its work task`,
    ),
  );
}

// Pushes the branch and fills in the PR, which stays a draft until the
// Reviewer's hardening marks it ready. A change that changes nothing goes
// to review as it is, saying so.
async function pushBranch(
  ctx: RoleContext,
  state: IssueState,
  summary: string,
): Promise<IssueState> {
  const opened = await opReply(
    ctx,
    "open-pr",
    {
      number: ctx.issue,
      title: ctx.inputs.issue.title,
      body: summary,
      by: { role: "developer" },
      reopen: state.pr,
    },
    OPEN_PR_REPLY,
  );
  const next: IssueState = {
    ...state,
    pr: opened.pr,
    headSha: opened.headSha,
    flows: { code: opened.codeChanged },
  };
  if (!opened.codeChanged) {
    return withLog(
      next,
      `the branch changes no file; the developer said: ${summary}`,
      new Date(),
    );
  }
  return next;
}

// The state after a new push: no hardening, approval, integration or
// security clearance of an earlier revision holds for it. A security
// rejection stays: it binds the exact landed result it rejected, so that
// result stops again however the issue comes back to it.
function freshChange(state: IssueState): IssueState {
  let { security } = state;
  if (security?.finding === null) {
    security = null;
  }
  return {
    ...state,
    stage: "review",
    landingReturn: null,
    hardened: null,
    integration: null,
    security,
    review: { ...state.review, verdict: null },
  };
}

async function develop(ctx: RoleContext): Promise<RoleEnd> {
  const mode = changeModeOf(ctx.state);
  let { state } = ctx;
  if (mode.kind === "branch") {
    const started = await opReply(
      ctx,
      "start-pr",
      { number: ctx.issue },
      START_PR_REPLY,
    );
    state = { ...state, pr: started.pr };
    await ctx.save(state);
  }
  const summary = await work(ctx, state, mode);
  if (!summary.ok) {
    return summary.end;
  }
  if (mode.kind === "branch") {
    state = await pushBranch(ctx, state, summary.value);
    const unrecorded = await recordImplementation(
      ctx,
      state,
      String(state.headSha),
    );
    if (unrecorded !== null) {
      return unrecorded;
    }
  }
  const head = state.headSha?.slice(0, SHORT_SHA) ?? "none";
  const entry = `pushed ${head}; on to review, which hardens it`;
  return {
    kind: "next",
    state: withLog(
      freshChange({
        ...state,
        requirementsInputs: ctx.inputs.revision,
        asked: null,
      }),
      entry,
      new Date(),
    ),
  };
}

const implementationRole: Role = async (ctx: RoleContext) => {
  if (developerRecoveryRequired(ctx.state)) {
    return errorStop(ctx.state, DEVELOPER_RECOVERY_REASON);
  }
  if (
    usedAuthor(ctx.state) &&
    !requirementsHold(ctx.state, ctx.inputs.gherkin, ctx.inputs.revision)
  ) {
    const state = requirementsState(ctx.state, "implement");
    if (state === null) {
      return errorStop(ctx.state, DEVELOPER_RECOVERY_REASON);
    }
    return { kind: "next", state };
  }
  return await develop(ctx);
};

export { implementationRole };
