// The Reviewer's own synchronization at merge (`conflicts-never-stop`): the
// issue's code branch rebased onto its base, only once the issue is at the
// head of the merge queue. Hardening and development never sync. A rebase
// that stops on conflicts is left in the checkout for a resolver session of
// the Reviewer, which stages its text. finish-sync owns continuation and
// refuses gitlink conflicts, returning later text stops, and checks the
// completed rebase before pushing. Each session that ends, however it ends, is one of the issue's `maxConflictFixes` attempts, counted and saved
// at once; a transient failure is none. A resolution that is rejected, or
// not finished, is preserved before cleanup and another attempt. If its
// recovery cannot be prepared, the original checkout is retained instead.
// At the code resolver limit, preserve the stopped pick and its evidence as a
// controlled conflict stop, without requesting destructive cleanup.

import type { RoleContext } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import type { Conflict, SyncReply } from "../op-replies.ts";
import {
  FINISH_REPLY,
  opReply,
  RETAINED_CONFLICT_REPLY,
  SYNC_REPLY,
} from "../op-replies.ts";
import type { Step } from "../writer-session.ts";
import {
  ended,
  errorStop,
  replyText,
  writerSession,
} from "../writer-session.ts";
import { resolverTask } from "./task.ts";

// The sync so far: the state, and why its last resolution was rejected, if
// one was.
interface Attempts {
  state: IssueState;
  rejected: string | null;
  maxConflictFixes: number;
  next?: Conflict;
}

const WHAT = "code conflict resolver";

function withConflictFix(state: IssueState, attempt: number): IssueState {
  return { ...state, counts: { ...state.counts, conflictFixes: attempt } };
}

// Rebases the issue's branch onto its base, keeping a stop's conflicts for
// a resolver.
async function syncBase(ctx: RoleContext): Promise<SyncReply> {
  const payload = { number: ctx.issue, keepConflict: true };
  return await opReply(ctx, "sync-base", payload, SYNC_REPLY);
}

// Preserves failed resolver work before aborting. The operation refuses
// destructive cleanup when it cannot prepare recovery.
async function abortRebase(ctx: RoleContext, reason: string): Promise<void> {
  const payload = { number: ctx.issue, abort: true, reason };
  await ctx.op("finish-sync", payload);
}

// One resolver session on the stopped rebase, then the finish's check. The
// attempts after it carry null as `rejected` when the rebase is resolved.
async function resolveOnce(
  ctx: RoleContext,
  run: Attempts,
  conflict: Conflict,
): Promise<Step<Attempts>> {
  const attempt = run.state.counts.conflictFixes + 1;
  const task = resolverTask(ctx, {
    ...conflict,
    attempt,
    max: run.maxConflictFixes,
    rejected: run.rejected,
  });
  const session = await writerSession(ctx, run.state, {
    phase: "integration",
    task,
    what: WHAT,
  });
  if (!session.ok) {
    await abortRebase(ctx, `the ${WHAT} session did not finish`);
    return session;
  }
  const state = withConflictFix(run.state, attempt);
  await ctx.save(state);
  const reply = session.value;
  const rejected = `the resolver replied ${reply.outcome}: ${replyText(reply)}`;
  let payload: object = { number: ctx.issue, baseSha: conflict.baseSha };
  if (reply.outcome !== "conflict-resolved") {
    // Classification and continuation are deterministic, even when the
    // model gave up. An explicit abort still rejects.
    payload = { ...payload, cannotFix: true, reason: rejected };
  }
  const finished = await opReply(ctx, "finish-sync", payload, FINISH_REPLY);
  if (finished.conflict) {
    return {
      ok: true,
      value: { ...run, state, rejected: null, next: finished },
    };
  }
  if (!finished.resolved) {
    return { ok: true, value: { ...run, state, rejected: finished.reason } };
  }
  const entry = `resolved the code rebase's conflicts on attempt ${attempt}`;
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

// Resolves the rebase that `synced` reports, within the issue's attempts:
// each attempt after a rejected one rebases afresh.
async function resolvedFrom(
  ctx: RoleContext,
  run: Attempts,
  synced: SyncReply,
): Promise<Step<IssueState>> {
  const { state, maxConflictFixes } = run;
  if (!synced.conflict) {
    return { ok: true, value: state };
  }
  if (!synced.inRebase) {
    const files = synced.conflicts.join(", ");
    const reason = `sync-base reported conflicts in ${files} but left no rebase to resolve`;
    return ended(errorStop(state, reason));
  }
  if (state.counts.conflictFixes >= maxConflictFixes) {
    const reason = `the code rebase still conflicts after the resolver's ${maxConflictFixes} attempts (maxConflictFixes)`;
    const retained = await opReply(
      ctx,
      "finish-sync",
      {
        number: ctx.issue,
        baseSha: synced.baseSha,
        retainConflict: true,
        reason,
      },
      RETAINED_CONFLICT_REPLY,
    );
    return conflictStop(run, retained.reason);
  }
  const resolved = await resolveOnce(ctx, run, synced);
  if (!resolved.ok) {
    return resolved;
  }
  if (resolved.value.next !== undefined) {
    const { next, ...remaining } = resolved.value;
    return await resolvedFrom(ctx, remaining, next);
  }
  if (resolved.value.rejected === null) {
    return { ok: true, value: resolved.value.state };
  }
  return await resolvedFrom(ctx, resolved.value, await syncBase(ctx));
}

// Rebases the issue's branch onto its base, resolving its conflicts within
// the issue's `maxConflictFixes` attempts.
async function syncCode(
  ctx: RoleContext,
  state: IssueState,
  maxConflictFixes: number,
): Promise<Step<IssueState>> {
  const run: Attempts = { state, rejected: null, maxConflictFixes };
  return await resolvedFrom(ctx, run, await syncBase(ctx));
}

export { syncCode };
