// Hippy's Sync task job (#186; `sync-is-a-task`): one run of a requested
// Sync binding, revision R onto the exact target commit T, through the Sync
// ops (#184). The ops check R, T, the inputs, the policy and every Land
// attempt fresh, record the attempt and result through the landing account,
// and push R′ through the development account. This role only routes:
//
//   binding passed         → nothing reruns; R′ goes on to fresh Hardening
//   binding unknown        → sync-task-reconcile settles it by reading
//   binding missing        → a new run, linked to the binding's latest one;
//                            a text stop goes to Hippy's resolver sessions
//   exhausted, held        → stop for a person
//
// A passed Sync saves R′ as the head with every approval of R voided, at
// review: R′ is a new revision that needs fresh Hardening. A failed run
// waits for a retry under the binding's budget; a retained conflict stops.
// Every Sync counts one of the issue's `maxSyncs` and each resolver session
// one of its `maxConflictFixes`, as the merge stage's own synchronization
// counted them before. It never fixes a check.

import { z } from "zod";
import type { Role, RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { TaskReport, TaskRequest } from "../../job/task-request.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";
import { SHORT_SHA } from "../change-task.ts";
import { opReply } from "../op-replies.ts";
import type { Run } from "../task-results.ts";
import { newRun, taskStatus } from "../task-results.ts";
import { errorStop, replyText, writerSession } from "../writer-session.ts";
import { resolverTask } from "./task.ts";

const LIMITS = z.looseObject({
  maxSyncs: z.number().int().nonnegative(),
  maxConflictFixes: z.number().int().nonnegative(),
});

const SHA = z.string().min(1);
const SYNC_REPLY = z.union([
  z.object({ ready: z.literal(false), reason: z.string() }),
  z.object({
    conflict: z.literal(true),
    conflicts: z.array(z.string()),
    target: SHA,
  }),
  z.object({ verdict: z.literal("passed"), produced: SHA }),
  z.object({
    verdict: z.literal("failed"),
    reason: z.string(),
    retained: z.boolean(),
  }),
]);
const RECONCILE_REPLY = z.union([
  z.object({ settled: z.literal("passed"), produced: SHA }),
  z.object({ settled: z.literal("failed"), reason: z.string() }),
  z.object({ settled: z.literal(false), reason: z.string() }),
]);

type SyncReply = z.infer<typeof SYNC_REPLY>;

const WHAT = "Sync conflict resolver";

function short(sha: string | null): string {
  return sha?.slice(0, SHORT_SHA) ?? "none";
}

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

// One Sync run: its request, its run, and the state it has saved.
interface SyncRun {
  request: TaskRequest;
  run: Run;
  state: IssueState;
  rejected: string | null;
}

// The revision R a Sync request binds.
function codeOf(request: TaskRequest): string | null {
  if ("revision" in request.binding) {
    return request.binding.revision.code;
  }
  return null;
}

function reportOf(
  request: TaskRequest,
  run: Run | null,
  verdict: TaskReport["verdict"],
  produced?: string,
): TaskReport {
  const report: TaskReport = { ...request, run, verdict };
  if (produced !== undefined) {
    report.produced = produced;
  }
  return report;
}

// R′ saved as the head, with every approval of R voided: back to review
// for fresh Hardening.
function synced(state: IssueState, produced: string, from: string): IssueState {
  return logged(
    {
      ...state,
      stage: "review",
      headSha: produced,
      verifiedSha: null,
      hardened: null,
      hardenedTarget: null,
      mergeReturn: null,
    },
    `Sync rebased ${short(from)} as ${short(produced)}; fresh Hardening is required`,
  );
}

function syncedEnd(
  request: TaskRequest,
  state: IssueState,
  { run, produced }: { run: Run | null; produced: string },
): RoleEnd {
  const from = codeOf(request);
  return {
    kind: "next",
    state: synced(state, produced, from ?? produced),
    task: reportOf(request, run, "passed", produced),
  };
}

function heldEnd(
  request: TaskRequest,
  state: IssueState,
  reason: string,
  verdict: TaskReport["verdict"] = "held",
): RoleEnd {
  return {
    ...errorStop(state, reason),
    task: reportOf(request, null, verdict),
  };
}

// One resolver session on the stopped rebase, then sync-task-finish.
async function resolveOnce(
  ctx: RoleContext,
  sync: SyncRun,
  conflicts: readonly string[],
): Promise<{ sync: SyncRun; reply: SyncReply } | { end: RoleEnd }> {
  const { maxConflictFixes } = LIMITS.parse(ctx.cfg);
  const attempt = sync.state.counts.conflictFixes + 1;
  const target = sync.request.binding.target.commit;
  const task = resolverTask(ctx, {
    conflicts,
    target,
    attempt,
    max: maxConflictFixes,
    rejected: sync.rejected,
  });
  const session = await writerSession(ctx, sync.state, {
    phase: "sync",
    task,
    what: WHAT,
  });
  const state: IssueState = {
    ...sync.state,
    counts: { ...sync.state.counts, conflictFixes: attempt },
  };
  await ctx.save(state);
  let payload: object = {};
  if (!session.ok) {
    // The run ends here: its work is kept in recovery and the run records
    // failed, so a retry is a new run.
    payload = { cannotFix: true, reason: `the ${WHAT} session did not finish` };
  } else if (session.value.outcome !== "conflict-resolved") {
    const reason = `the resolver replied ${session.value.outcome}: ${replyText(session.value)}`;
    payload = { cannotFix: true, reason };
  }
  const reply = await finish(ctx, sync, payload);
  if (!session.ok && "verdict" in reply) {
    return {
      end: {
        ...session.end,
        task: reportOf(sync.request, sync.run, reply.verdict),
      },
    };
  }
  return { sync: { ...sync, state }, reply };
}

async function finish(
  ctx: RoleContext,
  sync: SyncRun,
  payload: object,
): Promise<SyncReply> {
  return await opReply(
    ctx,
    "sync-task-finish",
    { binding: sync.request.binding, run: { id: sync.run.id }, ...payload },
    SYNC_REPLY,
  );
}

// Resolves `reply`'s stop within the issue's `maxConflictFixes` sessions,
// or retains it at the limit.
async function resolved(
  ctx: RoleContext,
  sync: SyncRun,
  reply: SyncReply,
): Promise<RoleEnd> {
  if (!("conflict" in reply)) {
    return ended(sync, reply);
  }
  const { maxConflictFixes } = LIMITS.parse(ctx.cfg);
  if (sync.state.counts.conflictFixes >= maxConflictFixes) {
    const reason = `the Sync rebase still conflicts after the resolver's ${maxConflictFixes} attempts (maxConflictFixes)`;
    const retained = await finish(ctx, sync, { retainConflict: true, reason });
    return ended(sync, retained);
  }
  const once = await resolveOnce(ctx, sync, reply.conflicts);
  if ("end" in once) {
    return once.end;
  }
  return await resolved(ctx, once.sync, once.reply);
}

// The end of a run whose reply settled it.
function ended(sync: SyncRun, reply: SyncReply): RoleEnd {
  const { request, run, state } = sync;
  if ("ready" in reply) {
    return {
      kind: "wait",
      reason: `Sync isn't needed: ${reply.reason}`,
      state,
      task: reportOf(request, null, "refused"),
    };
  }
  if ("conflict" in reply) {
    return heldEnd(
      request,
      state,
      "the Sync rebase stopped with no resolver left",
      "unknown",
    );
  }
  if (reply.verdict === "passed") {
    return syncedEnd(request, state, { run, produced: reply.produced });
  }
  const task = reportOf(request, run, "failed");
  if (reply.retained) {
    return {
      kind: "stop",
      code: "conflict",
      reason: reply.reason,
      state,
      task,
    };
  }
  return {
    kind: "wait",
    reason: `Sync failed and its work is kept in recovery: ${reply.reason}; a retry is a new run`,
    state,
    task,
  };
}

// A new run of the binding, within the issue's `maxSyncs`.
async function startRun(
  ctx: RoleContext,
  request: TaskRequest,
  run: Run,
): Promise<RoleEnd> {
  const { maxSyncs } = LIMITS.parse(ctx.cfg);
  const { syncs } = ctx.state.counts;
  if (syncs >= maxSyncs) {
    return {
      kind: "stop",
      code: "sync-limit",
      reason: `the base kept moving: the change was synced ${syncs} times (maxSyncs ${maxSyncs}) without landing`,
      state: ctx.state,
      task: reportOf(request, null, "held"),
    };
  }
  const state = logged(
    { ...ctx.state, counts: { ...ctx.state.counts, syncs: syncs + 1 } },
    `syncing ${short(codeOf(request))} onto ${short(request.binding.target.commit)}`,
  );
  await ctx.save(state);
  const reply = await opReply(
    ctx,
    "sync-task",
    { binding: request.binding, run },
    SYNC_REPLY,
  );
  return await resolved(ctx, { request, run, state, rejected: null }, reply);
}

// Settles the binding's unsettled run by reading, never by repeating it.
async function reconciled(
  ctx: RoleContext,
  request: TaskRequest,
  run: string,
): Promise<RoleEnd> {
  const reply = await opReply(
    ctx,
    "sync-task-reconcile",
    { binding: request.binding, run: { id: run } },
    RECONCILE_REPLY,
  );
  const settled = { id: run, previous: null };
  if (reply.settled === "passed") {
    return syncedEnd(request, ctx.state, {
      run: settled,
      produced: reply.produced,
    });
  }
  if (reply.settled === "failed") {
    return {
      kind: "wait",
      reason: `${reply.reason}; a retry is a new run`,
      state: ctx.state,
      task: reportOf(request, settled, "failed"),
    };
  }
  return heldEnd(
    request,
    ctx.state,
    `Sync run ${run} stays held: ${reply.reason}`,
    "unknown",
  );
}

const syncRole: Role = async (ctx: RoleContext): Promise<RoleEnd> => {
  const request = ctx.task ?? null;
  if (request === null || request.task !== "Sync") {
    return errorStop(
      ctx.state,
      "a Sync job runs only a requested Sync binding",
    );
  }
  const status = await taskStatus(ctx, request.binding);
  switch (status.status) {
    case "passed": {
      const produced = status.result.receipt.produced?.code;
      if (produced === undefined) {
        return heldEnd(
          request,
          ctx.state,
          "the passed Sync names no revision it produced",
        );
      }
      const run = { id: status.result.run.id, previous: null };
      if (ctx.state.headSha === produced) {
        // An earlier job saved R′ already; nothing reruns or resets.
        return {
          kind: "next",
          state: ctx.state,
          task: reportOf(request, run, "passed", produced),
        };
      }
      return syncedEnd(request, ctx.state, { run, produced });
    }
    case "unknown":
      return await reconciled(ctx, request, status.run);
    case "missing":
      return await startRun(ctx, request, newRun(status));
    case "held":
      return heldEnd(
        request,
        ctx.state,
        `the task results are held: ${status.reason}`,
      );
    default:
      return heldEnd(
        request,
        ctx.state,
        `Sync of this binding is ${status.status}; a person must decide`,
      );
  }
};

export { syncRole };
