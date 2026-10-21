// Where the merge job sends an issue it doesn't merge, and the bound on its
// own integrations. A changed input goes to the author, and a code head
// that moved by anything but the Reviewer's own integration goes back
// to review, which hardens it again: the merge never takes a revision no
// hardening or integration of it checked. Each integration counts one sync,
// and the one past `maxSyncs` stops the issue instead.

import { z } from "zod";
import type { RoleContext, RoleEnd } from "../../job/role-context.ts";
import type { IssueState } from "../../state.ts";
import { withLog } from "../../state.ts";

// The config's bound on the merge job's integrations; the config's defaults
// fill it in.
const SYNC_LIMIT = z.looseObject({ maxSyncs: z.number().int().nonnegative() });

function logged(state: IssueState, entry: string): IssueState {
  return withLog(state, entry, new Date());
}

// The state with its merge authorization voided: no hardening or
// integration of an earlier revision holds for the next one.
function voided(state: IssueState): IssueState {
  return { ...state, hardened: null, integration: null };
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

// One more counted integration, or the stop when `maxSyncs` of them already
// ran.
function counted(
  ctx: RoleContext,
  state: IssueState,
): { state: IssueState } | { stop: RoleEnd } {
  const { syncs } = state.counts;
  const limit = SYNC_LIMIT.parse(ctx.cfg).maxSyncs;
  if (syncs >= limit) {
    return {
      stop: {
        kind: "stop",
        code: "sync-limit",
        reason: `the base kept moving: the merge integrated the change ${syncs} times (maxSyncs ${limit}) without merging it`,
        state,
      },
    };
  }
  return { state: { ...state, counts: { ...state.counts, syncs: syncs + 1 } } };
}

export { counted, failed, logged, toAuthor, toReview, waiting };
