// The Developer (`implementor-owns-the-change`): the implement stage's one
// role. One session does the issue's work on the existing branch work, from
// the Gherkin and any merge return an earlier pipeline left, and the job
// pushes what it committed into the issue's draft PR, which stays a draft.
// The Developer never synchronizes the branch with its base and never owns
// the full verification: the Reviewer hardens and verifies the change next
// (src/roles/reviewer/). Its push makes any earlier hardening, approval or
// integration stale, so it clears them. Once the issue's code merged
// (`state.codeMerged`) only its wiki work remains: no PR, and a push of the
// wiki alone.

import { flowsOf } from "../../flows.ts";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import {
  OPEN_PR_REPLY,
  opReply,
  PUSH_REPLY,
  START_PR_REPLY,
} from "../op-replies.ts";
import type { Step } from "../writer-session.ts";
import { ended, errorStop, writerSession } from "../writer-session.ts";
import type { DevelopmentMode } from "./task.ts";
import { workTask } from "./task.ts";

const SHORT_SHA = 12;

function modeOf(state: IssueState): DevelopmentMode {
  if (state.codeMerged === null) {
    return { kind: "branch" };
  }
  return { kind: "wiki-only", merged: state.codeMerged };
}

// The session that does the issue's work; its summary on success.
async function work(
  ctx: RoleContext,
  state: IssueState,
  mode: DevelopmentMode,
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
// Reviewer approves it. A change that lives only in the wiki closes the
// draft, and once it is closed the issue has no PR; one that changes
// nothing goes to review as it is, saying so.
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
      by: { role: "implementor" },
      reopen: state.pr,
    },
    OPEN_PR_REPLY,
  );
  const flows = flowsOf(opened);
  let pr: number | null = opened.pr;
  if (!flows.code && flows.wiki) {
    await ctx.op("close-pr", { number: ctx.issue, pr: opened.pr });
    pr = null;
  }
  const next: IssueState = {
    ...state,
    pr,
    headSha: opened.headSha,
    flows,
  };
  if (!(flows.code || flows.wiki)) {
    return withLog(
      next,
      `the branch changes no file and the wiki has no commits; the developer said: ${summary}`,
      new Date(),
    );
  }
  return next;
}

// Pushes the wiki alone, after the code merged: the op refuses when the code
// checkout's head moved off the pushed branch.
async function pushWiki(
  ctx: RoleContext,
  state: IssueState,
): Promise<IssueState> {
  const pushed = await opReply(
    ctx,
    "push",
    { number: ctx.issue, wikiOnly: true },
    PUSH_REPLY,
  );
  return { ...state, headSha: pushed.headSha, flows: flowsOf(pushed) };
}

// The state after a new push: no hardening, approval or integration of an
// earlier revision holds for it.
function freshChange(state: IssueState): IssueState {
  return {
    ...state,
    stage: "review",
    mergeReturn: null,
    hardened: null,
    integration: null,
    review: { ...state.review, verdict: null },
  };
}

// An issue with no Gherkin comment goes to the author first.
function toAuthor(state: IssueState): RoleEnd {
  const next: IssueState = {
    ...state,
    stage: "author",
    resumeStage: "implement",
  };
  return {
    kind: "next",
    state: withLog(next, "no Gherkin comment yet; on to author", new Date()),
  };
}

async function develop(ctx: RoleContext): Promise<RoleEnd> {
  const mode = modeOf(ctx.state);
  let { state } = ctx;
  if (mode.kind === "branch") {
    const started = await opReply(
      ctx,
      "start-pr",
      { number: ctx.issue },
      START_PR_REPLY,
    );
    state = { ...state, pr: started.pr };
  }
  const summary = await work(ctx, state, mode);
  if (!summary.ok) {
    return summary.end;
  }
  if (mode.kind === "wiki-only") {
    state = await pushWiki(ctx, state);
  } else {
    state = await pushBranch(ctx, state, summary.value);
  }
  const head = state.headSha?.slice(0, SHORT_SHA) ?? "none";
  const entry = `pushed ${head}; on to review, which hardens it`;
  return { kind: "next", state: withLog(freshChange(state), entry, new Date()) };
}

const implementorRole: Role = async (ctx: RoleContext) => {
  if (ctx.inputs.gherkin === null) {
    return toAuthor(ctx.state);
  }
  return await develop(ctx);
};

export { implementorRole };
