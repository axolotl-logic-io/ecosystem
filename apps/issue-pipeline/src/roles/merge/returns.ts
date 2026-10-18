// Where the merge job sends an issue it doesn't merge. A changed input goes
// to the author, a changed code or wiki head to review, and a conflict or a
// failed check to implement. Each return the merge job causes counts one
// sync, and the one past `maxSyncs` stops the issue instead; only the
// implementor's resolver sessions count `conflictFixes`, so a conflict is
// never charged twice.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState, MergeReturn } from "../../state.ts";
import { withLog } from "../../state.ts";

// The config's bound on the merge job's returns; the config's defaults fill
// it in.
const SYNC_LIMIT = z.looseObject({ maxSyncs: z.number().int().nonnegative() });

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

// The state with the approval voided, keeping its revision for the record.
function voided(state: IssueState): IssueState {
  return { ...state, review: { ...state.review, verdict: null } };
}

function toAuthor(state: IssueState, why: string): RoleEnd {
  const next: IssueState = {
    ...voided(state),
    stage: "author",
    resumeStage: "review",
  };
  return { kind: "next", state: logged(next, `${why}; back to the author`) };
}

function toReview(state: IssueState, why: string): RoleEnd {
  const next: IssueState = { ...voided(state), stage: "review" };
  return { kind: "next", state: logged(next, `${why}; back to review`) };
}

function failed(state: IssueState, reason: string): RoleEnd {
  return { kind: "stop", code: "error", reason, state };
}

function waiting(state: IssueState, reason: string): RoleEnd {
  return { kind: "wait", reason, state };
}

// The stop for a return past the sync limit, by what the return was for.
const LIMIT_STOPS: Readonly<
  Record<MergeReturn["reason"] | "sync", { code: string; text: string }>
> = {
  conflict: {
    code: "conflict",
    text: "the rebase onto the base kept conflicting",
  },
  "wiki-conflict": {
    code: "conflict",
    text: "the wiki rebase kept conflicting",
  },
  retest: { code: "check-fixes", text: "checks still fail at merge" },
  ci: { code: "check-fixes", text: "checks still fail at merge (CI)" },
  "wiki-check": {
    code: "check-fixes",
    text: "checks still fail at merge (the wiki check)",
  },
  sync: { code: "sync-limit", text: "the base kept moving" },
};

// One more counted return, or the stop when `maxSyncs` returns already
// happened.
function counted(
  ctx: RoleContext,
  state: IssueState,
  kind: MergeReturn["reason"] | "sync",
): { state: IssueState } | { stop: RoleEnd } {
  const { syncs } = state.counts;
  const limit = SYNC_LIMIT.parse(ctx.cfg).maxSyncs;
  if (syncs >= limit) {
    const { code, text } = LIMIT_STOPS[kind];
    return {
      stop: {
        kind: "stop",
        code,
        reason: `${text}: the merge sent the issue back ${syncs} times (maxSyncs ${limit})`,
        state,
      },
    };
  }
  return { state: { ...state, counts: { ...state.counts, syncs: syncs + 1 } } };
}

// Back to implement with what failed at merge, on a state already counted.
function implementWith(
  state: IssueState,
  reason: MergeReturn["reason"],
  detail: string,
): RoleEnd {
  const mergeReturn: MergeReturn = {
    reason,
    detail,
    codeMerged: state.codeMerged !== null,
  };
  const next: IssueState = {
    ...voided(state),
    stage: "implement",
    mergeReturn,
  };
  return {
    kind: "next",
    state: logged(next, `merge: ${reason}: ${detail}; back to implement`),
  };
}

// Back to implement with what failed at merge, counted as one return.
function toImplement(
  ctx: RoleContext,
  state: IssueState,
  reason: MergeReturn["reason"],
  detail: string,
): RoleEnd {
  const bound = counted(ctx, state, reason);
  if ("stop" in bound) {
    return bound.stop;
  }
  return implementWith(bound.state, reason, detail);
}

// A sync moved the code or wiki head, so the reviewer sees the new head
// before it merges; never kept as approved.
function syncedToReview(
  ctx: RoleContext,
  state: IssueState,
  why: string,
): RoleEnd {
  const bound = counted(ctx, state, "sync");
  if ("stop" in bound) {
    return bound.stop;
  }
  return toReview(bound.state, why);
}

export {
  counted,
  failed,
  implementWith,
  logged,
  syncedToReview,
  toAuthor,
  toImplement,
  toReview,
  waiting,
};
