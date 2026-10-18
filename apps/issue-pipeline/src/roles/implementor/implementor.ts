// The implementor (`implementor-owns-the-change`): the implement stage's
// one role. It syncs the issue's branches (sync.ts), has one session do the
// issue's work on the existing branch work, from the Gherkin and the last
// review's findings or the merge's return, then verifies the result
// (checks.ts) and pushes exactly the verified head, filling in and readying
// the issue's draft PR. The issue then goes to review. Once the issue's code
// merged (`state.codeMerged`) only its wiki work remains: no code sync, no
// PR, and a push of the wiki alone; verify checks the merge commit.

import { z } from "zod";
import { flowsOf } from "../../flows.ts";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import { verifiedHead } from "./checks.ts";
import {
  OPEN_PR_REPLY,
  opReply,
  PUSH_REPLY,
  START_PR_REPLY,
} from "./op-replies.ts";
import type { Step } from "./session.ts";
import { ended, errorStop, implementorSession } from "./session.ts";
import { startSync } from "./sync.ts";
import type { Mode } from "./task.ts";
import { workTask } from "./task.ts";

// The config's limits on the implementor's loops.
const LIMITS = z.looseObject({
  maxCiFixes: z.number().int().nonnegative(),
  maxConflictFixes: z.number().int().nonnegative(),
});

const SHORT_SHA = 12;

function modeOf(state: IssueState): Mode {
  if (state.codeMerged === null) {
    return { kind: "branch" };
  }
  return { kind: "wiki-only", merged: state.codeMerged };
}

// The session that does the issue's work; its summary on success.
async function work(
  ctx: RoleContext,
  state: IssueState,
  mode: Mode,
): Promise<Step<string>> {
  const task = workTask(ctx, mode);
  const session = await implementorSession(ctx, state, {
    task,
    what: "implementor's",
  });
  if (!session.ok) {
    return session;
  }
  const reply = session.value;
  if (reply.outcome === "done") {
    return { ok: true, value: reply.summary };
  }
  if (reply.outcome === "cannot") {
    const reason = `the implementor could not do the issue as written: ${reply.reason}`;
    return ended({ kind: "stop", code: "not-doable", reason, state });
  }
  return ended(
    errorStop(
      state,
      `the implementor's session replied ${reply.outcome} to its work task`,
    ),
  );
}

// Pushes the branch and fills in the PR, which open-pr marks ready when the
// branch changes code. A change that lives only in the wiki closes the
// draft, and once it is closed the issue has no PR; one that changes nothing
// goes to review as it is, saying so.
async function pushBranch(
  ctx: RoleContext,
  state: IssueState,
  { summary, verified }: { summary: string; verified: string },
): Promise<Step<IssueState>> {
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
  if (opened.headSha !== verified) {
    return ended(
      errorStop(
        state,
        `open-pr pushed ${opened.headSha}, not the verified head ${verified}`,
      ),
    );
  }
  const flows = flowsOf(opened);
  let pr: number | null = opened.pr;
  if (!flows.code && flows.wiki) {
    await ctx.op("close-pr", { number: ctx.issue, pr: opened.pr });
    pr = null;
  }
  let next: IssueState = {
    ...state,
    pr,
    headSha: opened.headSha,
    verifiedSha: verified,
    flows,
  };
  if (!(flows.code || flows.wiki)) {
    next = withLog(
      next,
      `the branch changes no file and the wiki has no commits; the implementor said: ${summary}`,
      new Date(),
    );
  }
  return { ok: true, value: next };
}

// Pushes the wiki alone, after the code merged: the op refuses when the code
// checkout's head moved off the pushed branch. The verified code is the merge
// commit, which is what the review and the publish see.
async function pushWiki(
  ctx: RoleContext,
  state: IssueState,
  merged: { sha: string },
): Promise<IssueState> {
  const pushed = await opReply(
    ctx,
    "push",
    { number: ctx.issue, wikiOnly: true },
    PUSH_REPLY,
  );
  return {
    ...state,
    headSha: pushed.headSha,
    verifiedSha: merged.sha,
    flows: flowsOf(pushed),
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

async function implement(ctx: RoleContext): Promise<RoleEnd> {
  const limits = LIMITS.parse(ctx.cfg);
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
  const synced = await startSync(ctx, state, { mode, ...limits });
  if (!synced.ok) {
    return synced.end;
  }
  state = synced.value;
  const summary = await work(ctx, state, mode);
  if (!summary.ok) {
    return summary.end;
  }
  const verified = await verifiedHead(ctx, state, { mode, ...limits });
  if (!verified.ok) {
    return verified.end;
  }
  if (mode.kind === "wiki-only") {
    state = await pushWiki(ctx, state, mode.merged);
  } else {
    const pushed = await pushBranch(ctx, state, {
      summary: summary.value,
      verified: verified.value,
    });
    if (!pushed.ok) {
      return pushed.end;
    }
    state = pushed.value;
  }
  const done: IssueState = { ...state, stage: "review", mergeReturn: null };
  const entry = `verified ${verified.value.slice(0, SHORT_SHA)} and pushed; on to review`;
  return { kind: "next", state: withLog(done, entry, new Date()) };
}

const implementorRole: Role = async (ctx: RoleContext) => {
  if (ctx.inputs.gherkin === null) {
    return toAuthor(ctx.state);
  }
  return await implement(ctx);
};

export { implementorRole };
