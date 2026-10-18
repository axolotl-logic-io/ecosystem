// The start sync (`conflicts-never-stop`): the issue's code branch rebased
// onto its base and its wiki branch onto the wiki's latest version, before
// the work. A rebase that stops on conflicts is left in the checkout for a
// resolver session of the implementor, which resolves each stopped commit and
// continues the rebase itself; finish-sync or finish-wiki-sync then checks
// the result, and pushes it. Each resolver session that ends, however it
// ends, is one of the issue's `maxConflictFixes` attempts, counted and saved
// at once; a transient failure is none. A resolution that is rejected, or
// not finished, is dropped, and the next attempt rebases afresh.

import type { OpName, RoleContext } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import type { Conflict } from "./op-replies.ts";
import { FINISH_REPLY, opReply, SYNC_REPLY } from "./op-replies.ts";
import type { Step } from "./session.ts";
import { ended, errorStop, implementorSession, replyText } from "./session.ts";
import type { Mode, Side } from "./task.ts";
import { resolverTask } from "./task.ts";

interface SideOps {
  start: OpName;
  startPayload: (number: number) => object;
  finish: OpName;
  finishPayload: (number: number, conflict: Conflict) => object;
}

// One side's sync so far: the state, and why its last resolution was
// rejected, if one was.
interface Attempts {
  side: Side;
  state: IssueState;
  rejected: string | null;
  maxConflictFixes: number;
}

const SIDE_OPS: Readonly<Record<Side, SideOps>> = {
  code: {
    start: "sync-base",
    startPayload: (number: number) => ({ number, keepConflict: true }),
    finish: "finish-sync",
    finishPayload: (number: number, { baseSha }: Conflict) => ({
      number,
      baseSha,
    }),
  },
  wiki: {
    start: "wiki-sync",
    startPayload: (number: number) => ({ number }),
    finish: "finish-wiki-sync",
    finishPayload: (number: number) => ({ number }),
  },
};

function withConflictFix(state: IssueState, attempt: number): IssueState {
  return { ...state, counts: { ...state.counts, conflictFixes: attempt } };
}

// Drops the stopped rebase, putting the checkout back on its pushed branch.
async function abortRebase(
  ctx: RoleContext,
  side: Side,
  reason: string,
): Promise<void> {
  const payload = { number: ctx.issue, abort: true, reason };
  await ctx.op(SIDE_OPS[side].finish, payload);
}

// One resolver session on the stopped rebase, then the finish's check. The
// attempts after it carry null as `rejected` when the rebase is resolved.
async function resolveOnce(
  ctx: RoleContext,
  run: Attempts,
  conflict: Conflict,
): Promise<Step<Attempts>> {
  const { side, maxConflictFixes } = run;
  const attempt = run.state.counts.conflictFixes + 1;
  const task = resolverTask(ctx, side, {
    ...conflict,
    attempt,
    max: maxConflictFixes,
    rejected: run.rejected,
  });
  const what = `${side} conflict resolver`;
  const session = await implementorSession(ctx, run.state, { task, what });
  if (!session.ok) {
    await abortRebase(ctx, side, `the ${what} session did not finish`);
    return session;
  }
  const state = withConflictFix(run.state, attempt);
  await ctx.save(state);
  const reply = session.value;
  if (reply.outcome !== "conflict-resolved") {
    const rejected = `the resolver replied ${reply.outcome}: ${replyText(reply)}`;
    await abortRebase(ctx, side, rejected);
    return { ok: true, value: { ...run, state, rejected } };
  }
  const { finish, finishPayload } = SIDE_OPS[side];
  const payload = finishPayload(ctx.issue, conflict);
  const finished = await opReply(ctx, finish, payload, FINISH_REPLY);
  if (!finished.resolved) {
    return { ok: true, value: { ...run, state, rejected: finished.reason } };
  }
  const entry = `resolved the ${side} rebase's conflicts on attempt ${attempt}`;
  const logged = withLog(state, entry, new Date());
  return { ok: true, value: { ...run, state: logged, rejected: null } };
}

function conflictStop(run: Attempts, reason: string): Step<IssueState> {
  let why = reason;
  if (run.rejected !== null) {
    why = `${reason}; the last resolution was rejected: ${run.rejected}`;
  }
  return ended({
    kind: "stop",
    code: "conflict",
    reason: why,
    state: run.state,
  });
}

// Rebases one side, resolving its conflicts within the issue's attempts.
async function syncFrom(
  ctx: RoleContext,
  run: Attempts,
): Promise<Step<IssueState>> {
  const { side, state, maxConflictFixes } = run;
  const { start, startPayload } = SIDE_OPS[side];
  const reply = await opReply(ctx, start, startPayload(ctx.issue), SYNC_REPLY);
  if (!reply.conflict) {
    return { ok: true, value: state };
  }
  if (!reply.inRebase) {
    const files = reply.conflicts.join(", ");
    const reason = `${start} reported conflicts in ${files} but left no rebase to resolve`;
    return ended(errorStop(state, reason));
  }
  if (state.counts.conflictFixes >= maxConflictFixes) {
    const reason = `the ${side} rebase still conflicts after the resolver's ${maxConflictFixes} attempts (maxConflictFixes)`;
    await abortRebase(ctx, side, reason);
    return conflictStop(run, reason);
  }
  const resolved = await resolveOnce(ctx, run, reply);
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.value.rejected === null) {
    return { ok: true, value: resolved.value.state };
  }
  return await syncFrom(ctx, resolved.value);
}

// The start sync: the code side, unless the code already merged, then the
// wiki side, when the repo has a wiki.
async function startSync(
  ctx: RoleContext,
  start: IssueState,
  { mode, maxConflictFixes }: { mode: Mode; maxConflictFixes: number },
): Promise<Step<IssueState>> {
  let state = start;
  if (mode.kind === "branch") {
    const run: Attempts = {
      side: "code",
      state,
      rejected: null,
      maxConflictFixes,
    };
    const code = await syncFrom(ctx, run);
    if (!code.ok) {
      return code;
    }
    state = code.value;
  }
  if (ctx.dirs.docs === null) {
    return { ok: true, value: state };
  }
  const run: Attempts = {
    side: "wiki",
    state,
    rejected: null,
    maxConflictFixes,
  };
  return await syncFrom(ctx, run);
}

export { startSync };
